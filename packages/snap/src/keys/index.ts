import { SLIP10Node } from '@metamask/key-tree';
import type { SnapError } from '@metamask/snaps-sdk';
import { hash, Keypair } from '@stellar/stellar-sdk/base';
import { Buffer } from 'buffer';

import { externalServiceError, invalidRequest } from '../rpc/errors';
import type { SnapState } from '../state';
import { getState, MAX_ACCOUNT_INDEX, reconcileEntropyBinding } from '../state';

/**
 * A request's binding to the secret recovery phrase it was authorised under.
 *
 * Produced by {@link ensureEntropyBinding} and carried through every
 * grant-sensitive operation of the request that obtained it. `state` is a
 * snapshot read *after* the store was reconciled to `fingerprint`, and it is
 * checked to carry that fingerprint, so a grant or an account index read from
 * it belongs to the phrase the fingerprint names. Address resolution bound to
 * it refuses any node or memo entry of another phrase, and
 * {@link assertBindingCurrent} lets a handler refuse, after awaited work,
 * before it returns wallet-derived data or applies a side effect.
 *
 * What it deliberately does not carry is the parent node. Holding the
 * `m/44'/148'` subtree key for the life of a request would keep key material
 * live across Horizon lookups and open dialogs; the fingerprint is enough to
 * recognise the right node when one is fetched again.
 */
export type EntropyBinding = {
  /** The fingerprint of the phrase the wallet was deriving from. */
  fingerprint: string;
  /** A state snapshot whose persisted fingerprint equals `fingerprint`. */
  state: SnapState;
};

/**
 * Public addresses by account index, memoized for this execution context.
 *
 * Addresses are public, so this holds no secret. It exists so that resolving
 * a dapp-supplied address does not have to derive every revealed account on
 * every request: without it, repeatedly submitting an address the wallet does
 * not hold forces a full sweep each time, before any dialog or throttle can
 * intervene.
 *
 * Declared here, above its users, because the entropy binding below is what
 * governs its lifetime: the cache is only valid for as long as the secret
 * recovery phrase it was filled from stays the active one.
 */
const addressCache = new Map<number, string>();

/**
 * The fingerprint recorded for the entropy source seen in this execution
 * context, used to detect a change of secret recovery phrase.
 */
let contextFingerprint: string | null = null;

/**
 * The fingerprint each fetched parent node was observed under, immutable for
 * the node's lifetime.
 *
 * Requests overlap: one request can retain a parent node while another
 * observes a changed secret recovery phrase, clears the cache, and moves
 * {@link contextFingerprint} on. The retained node still derives valid-looking
 * addresses for a phrase the wallet no longer uses, and nothing about the node
 * itself says so. Recording the fingerprint per node is what lets a completion
 * prove, at the moment it caches or returns a result, that the phrase it
 * derived from is still the active one.
 */
const nodeFingerprints = new WeakMap<SLIP10Node, string>();

/**
 * Whether the given parent node still belongs to the active secret recovery
 * phrase.
 *
 * @param node - A parent node previously passed through
 * {@link bindToEntropySource}.
 * @returns True when its fingerprint is the one currently observed.
 */
function isNodeCurrent(node: SLIP10Node): boolean {
  const fingerprint = nodeFingerprints.get(node);
  return fingerprint !== undefined && fingerprint === contextFingerprint;
}

/**
 * The refusal every fingerprint check in this module ends in: the request
 * started under one secret recovery phrase and the wallet is now deriving
 * from another, so nothing the request has resolved describes this wallet.
 *
 * @returns The error, ready to throw.
 */
function phraseChangedError(): SnapError {
  return externalServiceError(
    'The active secret recovery phrase changed while this request was ' +
      'running, so its result no longer describes this wallet. Try again.',
  );
}

/**
 * Refuses a completion whose parent node was superseded by a change of secret
 * recovery phrase while the request was in flight.
 *
 * An address derived from a superseded node describes the *previous* wallet.
 * Returning it would hand an origin an address the wallet no longer holds,
 * and caching it would let every later call repeat that answer with no
 * fingerprint change left to detect. The request is rejected instead; a
 * retry derives from the phrase that is now active.
 *
 * @param node - The parent node the pending work derived from.
 * @throws An external-service error when the node is no longer current.
 */
function assertNodeCurrent(node: SLIP10Node): void {
  if (!isNodeCurrent(node)) {
    throw phraseChangedError();
  }
}

/**
 * Refuses a parent node that does not belong to the phrase a request was
 * authorised for.
 *
 * A request that passed its grant check under one fingerprint and fetches a
 * node afterwards can receive the node of a different phrase: the fetch
 * resolves whatever is primary *now*. Deriving from it would answer the
 * request with the new wallet's addresses under the old wallet's consent.
 *
 * @param node - A freshly fetched parent node.
 * @param fingerprint - The fingerprint the request is bound to.
 * @throws An external-service error when the node derives for another phrase.
 */
function assertNodeFingerprint(node: SLIP10Node, fingerprint: string): void {
  if (nodeFingerprints.get(node) !== fingerprint) {
    throw phraseChangedError();
  }
}

/**
 * A memoized address, but only while the memo still describes the phrase
 * the caller is bound to.
 *
 * The memo holds addresses of {@link contextFingerprint}'s phrase and nothing
 * else (it is cleared whenever that changes, and writes are gated on the
 * deriving node being current). A caller bound to an earlier fingerprint must
 * therefore see a miss, not the new phrase's address at the same index: the
 * miss sends it to fetch a node, and {@link assertNodeFingerprint} refuses
 * the request there.
 *
 * @param index - The account index.
 * @param fingerprint - The fingerprint the caller is bound to.
 * @returns The memoized address, or undefined on a miss.
 */
function cachedAddress(index: number, fingerprint: string): string | undefined {
  return contextFingerprint === fingerprint
    ? addressCache.get(index)
    : undefined;
}

/**
 * Stores a derived address in the memo, only when the node it was derived
 * from still belongs to the active phrase.
 *
 * The currency check happens *here*, synchronously at the write, and not only
 * inside {@link deriveAddress}: between a derivation settling and its caller's
 * continuation running, another request's binding can observe a new phrase and
 * clear the cache. A write guarded only upstream would then repopulate the
 * cleared cache with the old phrase's address.
 *
 * @param node - The parent node the address was derived from.
 * @param index - The account index.
 * @param address - The derived address.
 */
function cacheAddress(node: SLIP10Node, index: number, address: string): void {
  if (isNodeCurrent(node)) {
    addressCache.set(index, address);
  }
}

/**
 * The in-flight (or settled) persisted-binding reconciliation for this
 * execution context, or null when it has not run or last failed.
 *
 * A promise rather than a boolean, for two reasons. It latches on *settle*
 * rather than on entry, so a transient state-write failure leaves the binding
 * unreconciled and the next key use retries it: latching before the write
 * would let one failure disable, for the rest of the context, the check that
 * stops grants recorded under a previous secret recovery phrase from being
 * honoured. And because the assignment is a plain read-modify-write with no
 * `await` between the read and the write, concurrent callers share one
 * reconciliation instead of racing several.
 */
let bindingReconciliation: Promise<void> | null = null;

/**
 * The fingerprint {@link bindingReconciliation} was started for, or null when
 * none is latched. The latch is keyed to this rather than held for the whole
 * execution context: MetaMask can change its primary secret recovery phrase
 * while a context stays warm, and a reconciliation that ran for the previous
 * fingerprint says nothing about the store's relationship to the new one. A
 * fingerprint change therefore re-runs the reconciliation instead of reusing
 * the settled promise.
 */
let reconciledFingerprint: string | null = null;

/**
 * Identifies the reconciliation that is currently allowed to speak for the
 * binding. Keyed by identity, not only by fingerprint: a phrase can change
 * from A to B and back to A while A's first reconciliation is still in
 * flight, and the fingerprint alone cannot tell that older completion from
 * the one the second A period actually started. Only the reconciliation
 * holding this ticket when it settles may mark the binding verified.
 */
let reconciliationTicket: symbol | null = null;

/**
 * Whether the persisted binding has been *confirmed* in this execution
 * context, as opposed to merely attempted.
 *
 * Separate from {@link bindingReconciliation}, which latches on settle and so
 * cannot distinguish "reconciled" from "tried and failed": the reconciliation
 * is best effort on purpose, and its rejection arm deliberately lets key
 * derivation continue. This flag is what records that the store's binding to
 * the active secret recovery phrase is unconfirmed, so the callers for which
 * that matters can refuse. See {@link ensureEntropyBinding}.
 */
let bindingVerified = false;

/**
 * Clears the memoized addresses and the entropy binding recorded for this
 * execution context. Test hook.
 */
export function resetAddressCache(): void {
  addressCache.clear();
  contextFingerprint = null;
  bindingReconciliation = null;
  reconciledFingerprint = null;
  reconciliationTicket = null;
  bindingVerified = false;
}

/**
 * Fetches the SEP-0005 parent node `m/44'/148'` (curve ed25519), the subtree
 * the manifest grants entropy for. Callers that derive several accounts must
 * fetch it once and reuse it: every call crosses the sandbox boundary with
 * the parent key material, so repeating it per index multiplies that
 * exposure and the work an unauthenticated request can cause.
 *
 * @returns The SEP-0005 parent node.
 */
async function getAccountParentNode(): Promise<SLIP10Node> {
  const entropy = await snap.request({
    method: 'snap_getBip32Entropy',
    params: {
      // No `source`: this resolves the *primary* entropy source. MetaMask
      // supports several secret recovery phrases, so which one is primary is
      // an input to every address this snap shows. `bindToEntropySource` below
      // is what stops that input changing silently underneath the caches and
      // the stored account registry.
      path: ['m', "44'", "148'"],
      curve: 'ed25519',
    },
  });
  const node = await SLIP10Node.fromJSON(entropy);
  await bindToEntropySource(node);
  return node;
}

/**
 * Detects a change of secret recovery phrase and invalidates everything
 * derived from the previous one.
 *
 * {@link addressCache} is memoized by index alone, so without this it would
 * keep answering with addresses from a phrase the wallet no longer uses. The
 * signing path is not exposed to that (it re-derives and compares the result
 * against the address it was asked for, in `resolveSigningKeypair`). The
 * display path is, though: `getActiveAddress` feeds `requestAccess`,
 * `getAddress`, `fund`, and the home page straight from the cache. An address
 * returned there is one a dapp may pay to, so it gets the same treatment as
 * one that is signed for.
 *
 * The fingerprint hashes the parent node's public key: public data, never key
 * material, and stable for a given phrase.
 *
 * @param node - The freshly fetched SEP-0005 parent node.
 */
async function bindToEntropySource(node: SLIP10Node): Promise<void> {
  // `publicKeyBytes`, not the `publicKey` hex string: key-tree's hex getters
  // are `0x`-prefixed, and `Buffer.from` with 'hex' stops at the first
  // non-hex character, so hashing the string form digests an *empty* buffer.
  // Every phrase then shares one constant fingerprint and no change is ever
  // detected, which silently disables everything this function exists for.
  const fingerprint = hash(Buffer.from(node.publicKeyBytes)).toString('hex');
  // Recorded immutably against the node itself, so work that retained this
  // node across a later phrase change can prove which phrase it derives for.
  nodeFingerprints.set(node, fingerprint);
  if (contextFingerprint !== null && contextFingerprint !== fingerprint) {
    addressCache.clear();
  }
  contextFingerprint = fingerprint;
  // The persisted reconciliation costs a state read and is only meaningful
  // once per fingerprint, so it runs on the first key use for the phrase
  // being derived from and not on every parent-node fetch. Keying the latch
  // to the fingerprint (rather than latching once per execution context) is
  // what makes a mid-context phrase change re-run it: the settled promise for
  // the previous phrase must not stand in for a reconciliation the new phrase
  // has never had, or grants and account indices recorded under the old
  // phrase would stay in force against the new one.
  // Best effort, for the same reason the signing handlers record their grant
  // best effort: this is bookkeeping *about* the key material, and a store
  // that cannot be written must not take key derivation down with it. That
  // would turn a state-write failure into an inability to sign, which is
  // strictly worse than a fingerprint recorded one context later. The
  // in-context cache invalidation above does not depend on it.
  if (reconciledFingerprint !== fingerprint || bindingReconciliation === null) {
    const ticket = Symbol('reconciliation');
    reconciledFingerprint = fingerprint;
    reconciliationTicket = ticket;
    // Unverified until the reconciliation for *this* fingerprint settles: a
    // verification earned under the previous phrase does not carry over.
    bindingVerified = false;
    bindingReconciliation = reconcileEntropyBinding(fingerprint).then(
      (reset) => {
        // Guarded by identity, because a settle can arrive after another
        // reconciliation has superseded this one, and that later one may
        // even be for the same fingerprint (a phrase changed away and back):
        // the store it found is not the store this completion looked at, so
        // only the reconciliation that currently holds the ticket may speak
        // for the binding.
        if (reconciliationTicket === ticket) {
          // The store's binding is now known to describe the phrase being
          // derived from, which is the precondition every grant read depends
          // on.
          bindingVerified = true;
        }
        if (reset) {
          addressCache.clear();
        }
        return undefined;
      },
      () => {
        // Nothing is known about which phrase the stored grants belong to,
        // and the rejection is swallowed below so derivation survives.
        // Recording the failure is what lets the grant-gated callers refuse
        // instead.
        if (reconciliationTicket === ticket) {
          bindingVerified = false;
          // Clear the latch so the next key use retries. Retrying is cheap:
          // `lazyAccountParentNode` already collapses a request's parent-node
          // fetches into one, so this costs at most one extra attempt per
          // request, not one per derivation.
          bindingReconciliation = null;
          reconciledFingerprint = null;
          reconciliationTicket = null;
        }
        // Drop the cache as well. Nothing derived from the store is
        // known-good for this fingerprint while the binding is unverified,
        // and the display path (`getActiveAddress` and, through it,
        // `requestAccess`, `getAddress`, `fund`, and the home page) reads
        // addresses straight out of it. Key derivation itself is untouched,
        // which is the property the best-effort treatment exists to protect.
        addressCache.clear();
        return undefined;
      },
    );
  }
  await bindingReconciliation;
}

/**
 * Establishes the store's binding to the active secret recovery phrase, and
 * refuses when it cannot be established. Callers that are about to read a
 * connection grant must await this first.
 *
 * Two separate problems make it necessary.
 *
 * Ordering. {@link reconcileEntropyBinding} runs on first key use, so a handler
 * that reads a grant *before* deriving anything reads it from a store whose
 * phrase change has not been detected yet. `getAddress` was the sharpest case:
 * it checked the grant, then derived, and the derivation is what discovers the
 * mismatch and clears the grants, so the very call that revoked a grant still
 * answered it with the new phrase's address. Establishing the binding first
 * means a grant is only ever read from a reconciled store.
 *
 * Failure. Reconciliation is best effort where derivation is concerned, and
 * deliberately so: a store that cannot be written must not take signing down
 * with it (see {@link bindToEntropySource}). That reasoning does not carry over
 * to grants. A grant describes a specific key set, so a failed reconciliation
 * leaves the snap unable to say whether the recorded grants belong to the
 * phrase it is now deriving from, and honouring them anyway is precisely the
 * outcome the binding exists to prevent: consent given for one wallet extended
 * to another. So this refuses, while key derivation and cold signing (which
 * name no account and always show a dialog) keep working.
 *
 * Fetching the parent node explicitly, rather than reading an address out of
 * the memo, is what makes the check real. A warm memo short-circuits the
 * fetch entirely: no fetch means no {@link bindToEntropySource}, which means
 * no reconciliation, so neither a transient store failure nor a changed phrase
 * would ever be observed again. The memo is necessarily warm on exactly the
 * paths that matter, because derivation itself repopulates it. Regression
 * test: `src/handlers/access-guards.test.tsx`, "recovers once the store can
 * be written again".
 *
 * The fetch happens on every call, not only while unverified. A verification
 * earned earlier in the execution context describes the phrase that was
 * primary then; MetaMask can change its primary secret recovery phrase while
 * the context stays warm, and a grant must only ever be honoured against the
 * phrase that is primary *now*. Fetching the node is what surfaces the
 * current fingerprint, and {@link bindToEntropySource} re-reconciles whenever
 * it changed. One `snap_getBip32Entropy` per grant-gated request is the cost
 * of that guarantee.
 *
 * The state snapshot is read after the fetch, because the fetch is what
 * settles a pending reconciliation: read before it, `activeAccount` could be
 * an index recorded under a phrase the reconciliation is about to reset. It
 * is then checked to carry the node's fingerprint. Requests overlap, and a
 * concurrent one can observe a newer phrase and reconcile the store to it
 * between this request's reconciliation settling and its read; a snapshot
 * stamped with another fingerprint belongs to another wallet, and reading a
 * grant or an account index out of it would be exactly the cross-wallet
 * authorisation the binding exists to prevent. Refusing here is what lets
 * every caller treat `state` as "the store, as it belongs to `fingerprint`".
 *
 * Deriving the active account afterwards, rather than only fetching the node,
 * fills {@link addressCache}, so the address lookup every caller does
 * immediately afterwards is a cache hit rather than a second crossing of the
 * sandbox boundary with the parent key material.
 *
 * The returned binding carries the node's own fingerprint rather than
 * whatever is current at return time, so a concurrent change cannot swap in
 * the newer value between the fetch and the capture. A caller that goes on
 * to write (a grant, an account reveal, a network or token change) passes it
 * to the state helper, which compares it against the store inside the state
 * lock, so an approval collected for this phrase cannot land in another
 * phrase's state.
 *
 * @returns The confirmed binding: the fingerprint and a state snapshot that
 * belongs to it.
 * @throws An external-service error when the binding cannot be confirmed, or
 * when the phrase changed underneath the request.
 */
export async function ensureEntropyBinding(): Promise<EntropyBinding> {
  const node = await getAccountParentNode();
  assertNodeCurrent(node);
  const fingerprint = nodeFingerprints.get(node);
  if (!bindingVerified || fingerprint === undefined) {
    throw externalServiceError(
      'The wallet could not confirm which secret recovery phrase this snap ' +
        'stored its data under, so connected-site permissions cannot be used ' +
        'right now. Try again shortly.',
    );
  }
  const state = await getState();
  if (state.entropyFingerprint !== fingerprint) {
    throw phraseChangedError();
  }
  const { activeAccount } = state;
  if (cachedAddress(activeAccount, fingerprint) === undefined) {
    cacheAddress(node, activeAccount, await deriveAddress(node, activeAccount));
  }
  // The derivation above is the last await; the node's currency was asserted
  // inside it. Re-checked here for the memo-hit path, which awaited nothing
  // since the state read and could otherwise return a binding whose
  // fingerprint a concurrent request has already superseded.
  assertNodeCurrent(node);
  return { fingerprint, state };
}

/**
 * Refuses a request whose binding no longer describes the phrase the wallet
 * is deriving from.
 *
 * Handlers call this after awaited work (a Horizon lookup, a contract read)
 * and immediately before they return wallet-derived data or apply a
 * side effect. The binding's own checks cover everything that derives; this
 * covers the stretch between the last derivation and the answer, where a
 * concurrent request may have observed a new phrase and reset the store
 * under which this request's grant was honoured.
 *
 * In-context only: it compares against the fingerprint most recently
 * observed by *any* request in this execution context, which is precisely
 * the signal an overlapping request leaves behind. A change no request has
 * observed yet is invisible here, and is caught by the next fetch.
 *
 * @param binding - The binding the request was authorised under.
 * @throws An external-service error when the phrase has changed since.
 */
export function assertBindingCurrent(binding: EntropyBinding): void {
  if (contextFingerprint !== binding.fingerprint) {
    throw phraseChangedError();
  }
}

/**
 * Derives one account keypair from an already-fetched parent node.
 *
 * The index bound is re-asserted here, at the primitive itself, rather than
 * trusting every caller: this is the only place an index becomes a signing
 * key, so an index that escaped state validation must not derive.
 *
 * @param node - The SEP-0005 parent node.
 * @param index - The SEP-0005 account index (`x` in `m/44'/148'/x'`).
 * @returns The Stellar keypair for the account.
 */
async function deriveFromNode(
  node: SLIP10Node,
  index: number,
): Promise<Keypair> {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_ACCOUNT_INDEX) {
    throw invalidRequest('Invalid account index.');
  }

  const child = await node.derive([`slip10:${index}'`]);

  if (!child.privateKeyBytes) {
    throw new Error('Failed to derive a private key.');
  }

  // The copy is zeroed once the keypair holds its own seed, so this function
  // leaves one fewer reachable copy of the account's secret behind than it
  // creates. `Keypair.fromRawEd25519Seed` copies rather than retaining the
  // buffer (verified against @stellar/stellar-sdk 16.2.0: signing and
  // `rawSecretKey()` are unaffected by clearing it afterwards), so this is
  // safe; a future SDK that started retaining it would break signing loudly in
  // the SEP-0005 vector tests rather than silently.
  //
  // Deliberately NOT zeroed: `child.privateKeyBytes` itself. That is the
  // SLIP10Node's own field, not a copy handed out, so clearing it would corrupt
  // the node for any later derivation from the same parent. And this is
  // mitigation, not a guarantee: the parent node still holds the subtree key
  // for the lifetime of the request, and a JavaScript runtime may have copied
  // any of it out of reach. It narrows the window; it does not close it.
  const seed = Buffer.from(child.privateKeyBytes);
  try {
    return Keypair.fromRawEd25519Seed(seed);
  } finally {
    seed.fill(0);
  }
}

/**
 * Derives an account's public address, wiping the keypair that had to be
 * materialized to read it.
 *
 * Every address lookup in this module goes through key derivation, because
 * that is the only way to learn a SEP-0005 address. The keypair it produces is
 * then immediately garbage, but garbage that holds an account secret: without
 * the wipe, `getOwnedAccounts` leaves one unwiped account secret per revealed
 * account behind on every home-page render and on every `fund`, `getBalances`,
 * and `getAccounts` call, and {@link findAccountIndexByAddress} leaves up to
 * {@link MAX_ACCOUNT_INDEX} of them behind on a single unmatched search. That
 * is the great majority of the account secrets this snap ever materializes,
 * and none of it is needed for longer than the `publicKey()` call below.
 *
 * Reading the public key before the wipe is required, not incidental: the seed
 * and the secret key are the same buffer, so a wiped keypair cannot sign, but
 * the public key is computed in the constructor and survives (see
 * {@link wipeKeypair}). Mitigation, not a guarantee, in the sense
 * {@link deriveFromNode} sets out.
 *
 * The node's currency is asserted after the derivation settles: a request that
 * retained this node across a change of secret recovery phrase would otherwise
 * complete with an address of the previous wallet, after the change had
 * already been observed, reconciled, and cache-cleared by a newer request.
 * See {@link assertNodeCurrent}.
 *
 * @param node - The SEP-0005 parent node.
 * @param index - The SEP-0005 account index.
 * @returns The `G...` address.
 */
async function deriveAddress(node: SLIP10Node, index: number): Promise<string> {
  const keypair = await deriveFromNode(node, index);
  try {
    const address = keypair.publicKey();
    assertNodeCurrent(node);
    return address;
  } finally {
    wipeKeypair(keypair);
  }
}

/**
 * Derive the SEP-0005 keypair `m/44'/148'/{index}'` from the MetaMask secret
 * recovery phrase. The manifest grants entropy for the `m/44'/148'` subtree
 * (curve ed25519); the account-level hardened index is derived in-snap.
 *
 * Keys are derived on demand and never persisted. Conformance against the
 * official SEP-0005 test vectors is enforced by the test suite.
 *
 * @param index - The SEP-0005 account index (`x` in `m/44'/148'/x'`).
 * @returns The Stellar keypair for the account.
 */
export async function deriveKeypair(index = 0): Promise<Keypair> {
  return deriveFromNode(await getAccountParentNode(), index);
}

/**
 * Zeroes the account secret a keypair holds, once the signature it was derived
 * for has been produced.
 *
 * {@link deriveFromNode} already zeroes the copy it makes, and that is safe
 * because `Keypair.fromRawEd25519Seed` copies the buffer rather than retaining
 * it. The same fact is why this is needed: the copy the keypair took is live,
 * and nothing else drops it. Without this it stays reachable for the rest of
 * the request, which for a submitting `signTransaction` includes a network
 * round trip to a third-party endpoint.
 *
 * Two properties of the SDK this relies on, both verified against version
 * 16.2.0 and both asserted in `src/keys/index.test.ts`. `rawSecretKey()`
 * returns the live buffer rather than a copy, so filling it actually clears the
 * keypair's own seed; and the public key is computed once in the constructor,
 * so `publicKey()` keeps working afterwards. What does NOT keep working is
 * signing, since the seed and the secret key are the same buffer: a keypair
 * must be wiped only after its final use, which is why each call site sits
 * after the last signature it produces rather than in a shared wrapper.
 *
 * Mitigation, not a guarantee, in exactly the sense {@link deriveFromNode}
 * describes: a JavaScript runtime may have copied the bytes somewhere out of
 * reach. It narrows the window.
 *
 * @param keypair - The keypair to wipe.
 */
export function wipeKeypair(keypair: Keypair): void {
  try {
    keypair.rawSecretKey().fill(0);
  } catch {
    // A keypair without a secret seed has nothing to wipe. Never let
    // best-effort cleanup mask the outcome of the signature it follows.
  }
}

/**
 * A memoizing getter for the SEP-0005 parent node: fetches on first use,
 * then reuses the same promise. Handed to the helpers below so one request's
 * whole resolution flow (cache fill plus final derivation) crosses the
 * sandbox boundary with the parent key material at most once.
 *
 * @returns A getter resolving the parent node.
 */
function lazyAccountParentNode(): () => Promise<SLIP10Node> {
  let cached: Promise<SLIP10Node> | null = null;
  return async () => {
    cached ??= getAccountParentNode();
    return cached;
  };
}

/**
 * Resolves the address for each of the given indices, deriving the parent
 * node at most once and filling the memo along the way.
 *
 * Returns the resolved pairs rather than leaving callers to read them back
 * out of {@link addressCache}. That is not a style preference: fetching the
 * parent node can *clear* the cache (`bindToEntropySource` does so when the
 * secret recovery phrase changed), so a caller that decided which indices
 * were missing, awaited the node, and then re-read the map could read
 * `undefined` for an index it had seen a moment earlier. Today the clear can
 * only happen on the first parent-node fetch in an execution context, when
 * the cache is necessarily empty, so nothing is lost; returning the derived
 * values means that argument is not load-bearing and a future reordering
 * cannot turn it into `undefined` flowing out through `getAccounts` and the
 * home page as though it were an address.
 *
 * Every resolution is bound to a fingerprint. A memo entry is used only while
 * the memo still belongs to that phrase ({@link cachedAddress}), and a node
 * fetched to fill a miss is refused unless it derives for it
 * ({@link assertNodeFingerprint}). Between them, a request authorised under
 * one phrase can never be answered with another phrase's addresses, whichever
 * of the two happens to be current by the time it resolves.
 *
 * @param indices - The account indices to resolve.
 * @param fingerprint - The fingerprint the resolution is bound to.
 * @param getNode - The parent-node getter; callers that also derive a key
 * afterwards pass their own so the fetch is shared across both steps.
 * @returns The `{ index, address }` pair for each requested index, in the
 * order given.
 */
async function resolveAddresses(
  indices: number[],
  fingerprint: string,
  getNode: () => Promise<SLIP10Node> = lazyAccountParentNode(),
): Promise<{ index: number; address: string }[]> {
  // Fetch the node (and settle any cache invalidation it triggers) before
  // reading the memo, so every read below observes the post-binding cache.
  let node: SLIP10Node | null = null;
  if (
    indices.some((index) => cachedAddress(index, fingerprint) === undefined)
  ) {
    node = await getNode();
    assertNodeFingerprint(node, fingerprint);
  }
  return Promise.all(
    indices.map(async (index) => {
      const cached = cachedAddress(index, fingerprint);
      if (cached !== undefined) {
        return { index, address: cached };
      }
      let parent = node;
      if (parent === null) {
        parent = await getNode();
        assertNodeFingerprint(parent, fingerprint);
      }
      const address = await deriveAddress(parent, index);
      cacheAddress(parent, index, address);
      return { index, address };
    }),
  );
}

/**
 * Finds which SEP-0005 index derives a given address, or null when none of
 * the derivable indices does.
 *
 * This is what lets a user reach an account they already hold in another
 * SEP-0005 wallet: they know its address, not the index it sits at. The
 * search is purely local derivation over the bounded index range, with no
 * network lookup, so it discloses nothing and cannot be driven by a dapp:
 * only the home page calls it, in response to the user's own input.
 *
 * Derivation stops at the first match, and results fill the shared address
 * cache, so a repeated search costs nothing beyond the first.
 *
 * @param address - The `G...` address to locate.
 * @returns The account index, or null when the address is not derivable
 * from this wallet's secret recovery phrase.
 */
export async function findAccountIndexByAddress(
  address: string,
): Promise<number | null> {
  const getNode = lazyAccountParentNode();
  for (let index = 0; index < MAX_ACCOUNT_INDEX; index += 1) {
    let candidate = addressCache.get(index);
    if (candidate === undefined) {
      const node = await getNode();
      candidate = await deriveAddress(node, index);
      cacheAddress(node, index, candidate);
    }
    if (candidate === address) {
      return index;
    }
  }
  return null;
}

/**
 * The public address for a SEP-0005 account index, under the phrase the
 * caller is bound to.
 *
 * @param binding - The request's entropy binding.
 * @param index - The account index.
 * @returns The `G...` address.
 */
export async function getAddressForIndex(
  binding: EntropyBinding,
  index: number,
): Promise<string> {
  const [resolved] = await resolveAddresses([index], binding.fingerprint);
  if (resolved === undefined) {
    // `resolveAddresses` answers one pair per requested index; asserted
    // rather than cast away.
    throw new Error('Failed to derive the requested account.');
  }
  return resolved.address;
}

/**
 * The active account's public address: the index the binding's snapshot
 * names, derived under the binding's phrase.
 *
 * @param binding - The request's entropy binding.
 * @returns The `G...` address.
 */
export async function getActiveAddress(
  binding: EntropyBinding,
): Promise<string> {
  return getAddressForIndex(binding, binding.state.activeAccount);
}

/**
 * Every revealed account with its address, in index order.
 *
 * The registry comes from the binding's snapshot, not from a fresh state
 * read: the snapshot is the one known to belong to the phrase the addresses
 * are derived under, and a fresh read could already describe another.
 *
 * @param binding - The request's entropy binding.
 * @returns `{ index, address }` for each account in the snapshot.
 */
export async function getOwnedAccounts(
  binding: EntropyBinding,
): Promise<{ index: number; address: string }[]> {
  return resolveAddresses(binding.state.accounts, binding.fingerprint);
}

/**
 * Resolves the SEP-43 `address` option to an owned account's *index and
 * address* (Freighter parity: "switch to that account if available"), staying
 * fail-closed: only indices the user has revealed (`state.accounts`) are
 * ever derived and compared, so an origin cannot probe or sign for an
 * arbitrary never-revealed index. No selection means the active account.
 *
 * Deliberately does not return a keypair. This is the half of signer
 * resolution that runs *before* the confirmation dialog, and everything a
 * dialog needs is here: the index and the address are what it renders. The
 * signing key is derived afterwards by {@link deriveSigningKeypair}, once the
 * user has approved.
 *
 * That split is the point. Materializing the keypair here left an account
 * secret live in the snap heap for the whole pre-dialog phase (a Soroban
 * simulation, up to seven Horizon lookups, or two ledger reads) *and* for
 * however long the user spent reading the dialog, which the manifest bounds
 * only at `maxRequestTime`, 60 seconds. Deriving after approval narrows that
 * window to the signature itself. It is the same reasoning {@link wipeKeypair}
 * already applies to the tail of the request, applied to the much longer head
 * of it, and the same caveat holds: this narrows the window, it does not close
 * it.
 *
 * The result also carries the entropy fingerprint the resolution was made
 * under. The address returned here is what the confirmation dialog displays,
 * so the fingerprint names the wallet the user's approval is *about*; a
 * handler that records a grant from that approval passes it to
 * `connectOrigin`, which refuses to attach the grant to a store whose phrase
 * has since changed. It is the fingerprint of the node actually used, not
 * whatever is current at return time, so a concurrent phrase change cannot
 * swap in the newer value between the fetch and the capture.
 *
 * When the caller holds a binding (every explicit account selection does:
 * selection requires a grant, and the grant check produces one), the
 * resolution is confined to it. The node is refused unless it derives for the
 * binding's phrase, *before* any address is compared, and the registry is
 * read from the binding's snapshot rather than from fresh state. Without
 * that, an origin granted under one phrase could run an explicit-address
 * request across a phrase change and learn, from whether it reached a dialog
 * or was refused, which addresses the *new* wallet holds: the membership
 * oracle that gating selection on a grant exists to close. With it, a phrase
 * change produces the same refusal whatever address was named.
 *
 * @param requestedAddress - The `address` option, when the dapp sent one.
 * @param binding - The binding the selection was authorised under, when the
 * caller holds one. Cold signing (no address, no grant) has none.
 * @returns The signing account's index and address, and the entropy
 * fingerprint the resolution observed.
 * @throws An invalid-request error when the address is not held, or an
 * external-service error when the phrase is not the binding's.
 */
export async function resolveSigningAccount(
  requestedAddress?: string,
  binding?: EntropyBinding,
): Promise<{ index: number; address: string; entropyFingerprint: string }> {
  // Fetch the parent node before reading state, not after. Fetching is what
  // detects a changed secret recovery phrase and settles the persisted-state
  // reconciliation that resets accounts recorded under the old one; a state
  // snapshot taken first could hand this function an account index from the
  // previous phrase, and the dialog would then present (and the wallet sign
  // for) a selection the reset was about to discard. The getter is shared
  // with the address resolution below, so this stays one fetch per request.
  const getNode = lazyAccountParentNode();
  const node = await getNode();
  const entropyFingerprint = nodeFingerprints.get(node);
  if (entropyFingerprint === undefined) {
    // Every node passes through `bindToEntropySource`, which records the
    // fingerprint; asserted rather than cast away.
    throw new Error('The parent node carries no entropy fingerprint.');
  }
  if (binding !== undefined) {
    assertNodeFingerprint(node, binding.fingerprint);
  }
  const state = binding?.state ?? (await getState());
  if (requestedAddress === undefined) {
    const [active] = await resolveAddresses(
      [state.activeAccount],
      entropyFingerprint,
      getNode,
    );
    if (active === undefined) {
      // `resolveAddresses` answers one pair per requested index; asserted
      // rather than cast away.
      throw new Error('Failed to derive the active account.');
    }
    return { ...active, entropyFingerprint };
  }

  // Resolve through the address index, so an address the wallet does not hold
  // is rejected without deriving a signing key at all. Repeating an unowned
  // address is then a map lookup rather than a full sweep of every revealed
  // account.
  const owned = await resolveAddresses(
    state.accounts,
    entropyFingerprint,
    getNode,
  );
  const match = owned.find((entry) => entry.address === requestedAddress);
  if (match === undefined) {
    throw invalidRequest('Unknown address: this wallet does not hold it.');
  }
  return { ...match, entropyFingerprint };
}

/**
 * Derives the signing keypair for an already-resolved account, refusing when
 * it does not match the address that resolution named.
 *
 * The check is not redundant with {@link resolveSigningAccount}. That function
 * may answer from {@link addressCache}, which is derived state, and its result
 * is what the user saw in the dialog they approved. So this re-derives and
 * compares: a signature is only ever produced by the key that really does
 * belong to the address that was displayed. A mismatch drops the cache, since
 * a cache that mis-answered once cannot be trusted for anything else either.
 *
 * This fetches the parent node a second time, rather than sharing the one
 * {@link resolveSigningAccount} used. That is deliberate: sharing it would
 * mean holding the `m/44'/148'` subtree key across the dialog, which is
 * strictly more key material for strictly longer than the single account
 * keypair this split exists to avoid holding there. One extra
 * `snap_getBip32Entropy` on an approved signature is the right trade.
 *
 * @param index - The account index resolution returned.
 * @param expectedAddress - The address resolution returned, and the dialog
 * showed.
 * @returns The signing keypair. Callers must {@link wipeKeypair} it after
 * their final signature.
 * @throws An invalid-request error when the derived key is not that address.
 */
export async function deriveSigningKeypair(
  index: number,
  expectedAddress: string,
): Promise<Keypair> {
  const keypair = await deriveKeypair(index);
  if (keypair.publicKey() !== expectedAddress) {
    wipeKeypair(keypair);
    addressCache.clear();
    throw invalidRequest('Unknown address: this wallet does not hold it.');
  }
  return keypair;
}

/*
 * There is deliberately no `resolveSigningKeypair` composing the two functions
 * above. Every production caller has a confirmation dialog between the halves,
 * which is the whole reason they are separate, so a combined helper would have
 * no call site and would ship an uncalled export inside a shasum-sealed
 * signing bundle. The tests compose it themselves where they need the
 * end-to-end path.
 */
