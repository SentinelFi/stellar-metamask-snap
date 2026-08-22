import { SLIP10Node } from '@metamask/key-tree';
import type { SnapError } from '@metamask/snaps-sdk';
import { hash, Keypair, StrKey } from '@stellar/stellar-sdk/base';
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
 * A memoized address, but only while the memo still describes the phrase
 * the caller is bound to.
 *
 * The memo holds addresses of {@link contextFingerprint}'s phrase and nothing
 * else (it is cleared whenever that changes, and every write is gated on the
 * phrase the address came from still being current). A caller bound to an
 * earlier fingerprint must therefore see a miss, not the new phrase's address
 * at the same index: the miss sends it to fetch the key, and the fetch is
 * confirmed against the binding before anything is cached or returned (see
 * {@link resolveAddresses}).
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
 * The SEP-0005 subtree `m/44'/148'` (curve ed25519), the one path the
 * manifest grants key access for. Account `x` lives at `m/44'/148'/x'`.
 */
const SUBTREE_PATH = ['m', "44'", "148'"];

/**
 * The shape MetaMask reports an ed25519 public key in: `0x`, a zero prefix
 * byte, then the 32-byte key, as 66 hex characters.
 */
const ED25519_PUBLIC_KEY_HEX = /^0x00[0-9a-f]{64}$/iu;

/**
 * The entropy fingerprint of a phrase: a SHA-256 of the subtree's public
 * key bytes. Public data, never key material, and stable for a given phrase.
 *
 * Computed from the 33-byte key-tree form (zero prefix included) whether the
 * bytes came with a parent node or from a public-key request, so both routes
 * to the same phrase agree on one fingerprint and a store written under
 * either stays recognised by the other.
 *
 * @param publicKeyBytes - The subtree's public key bytes.
 * @returns The fingerprint, as hex.
 */
function fingerprintOf(publicKeyBytes: Uint8Array): string {
  // The bytes, not key-tree's `publicKey` hex string: that getter is
  // `0x`-prefixed, and `Buffer.from` with 'hex' stops at the first non-hex
  // character, so hashing the string form digests an *empty* buffer. Every
  // phrase then shares one constant fingerprint and no change is ever
  // detected, which silently disables everything the binding exists for.
  return hash(Buffer.from(publicKeyBytes)).toString('hex');
}

/**
 * Fetches the public key at a path under the subtree, with no private
 * material crossing the sandbox boundary.
 *
 * This is how every display path learns an address or a fingerprint. The
 * parent node (which carries the private key for the whole subtree) is
 * imported only where a private key is actually needed: to sign, and for the
 * user-driven account sweep in {@link findAccountIndexByAddress}, where one
 * node fetch stands in for up to 256 round trips.
 *
 * @param path - The BIP-32 path, `SUBTREE_PATH` or one account below it.
 * @returns The 33-byte public key (zero prefix, then the ed25519 key).
 */
async function fetchPublicKeyBytes(path: string[]): Promise<Buffer> {
  const publicKey = await snap.request({
    method: 'snap_getBip32PublicKey',
    params: {
      // No `source`: this resolves the *primary* entropy source, exactly as
      // the entropy request in `getAccountParentNode` does, so the two agree
      // on which phrase is being described.
      path,
      curve: 'ed25519',
    },
  });
  // The platform types this as a string; the shape check is defence against
  // a runtime that answers with something else, which must not become an
  // address or a fingerprint.
  if (
    typeof publicKey !== 'string' ||
    !ED25519_PUBLIC_KEY_HEX.test(publicKey)
  ) {
    throw externalServiceError(
      'The wallet returned a public key in an unexpected form.',
    );
  }
  return Buffer.from(publicKey.slice(2), 'hex');
}

/**
 * Observes which secret recovery phrase is primary right now and binds this
 * execution context to it, importing no private material to do so.
 *
 * @returns The fingerprint observed.
 */
async function observeEntropyFingerprint(): Promise<string> {
  const fingerprint = fingerprintOf(await fetchPublicKeyBytes(SUBTREE_PATH));
  await bindFingerprint(fingerprint);
  return fingerprint;
}

/**
 * Fetches the address of one SEP-0005 account from its public key alone.
 *
 * The index bound is re-asserted here, at the primitive itself, exactly as
 * {@link deriveFromNode} does for the private-key route: an index that
 * escaped state validation must not reach the platform.
 *
 * @param index - The SEP-0005 account index (`x` in `m/44'/148'/x'`).
 * @returns The `G...` address.
 */
async function fetchAddress(index: number): Promise<string> {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_ACCOUNT_INDEX) {
    throw invalidRequest('Invalid account index.');
  }
  const publicKey = await fetchPublicKeyBytes([...SUBTREE_PATH, `${index}'`]);
  // Drop the zero prefix byte: a Stellar address encodes the bare 32-byte
  // ed25519 key.
  return StrKey.encodeEd25519PublicKey(Buffer.from(publicKey.subarray(1)));
}

/**
 * Fetches the SEP-0005 parent node `m/44'/148'` (curve ed25519), the subtree
 * the manifest grants entropy for. Callers that derive several accounts must
 * fetch it once and reuse it: every call crosses the sandbox boundary with
 * the parent key material, so repeating it per index multiplies that
 * exposure and the work an unauthenticated request can cause.
 *
 * Only two kinds of caller import this node: signing, which needs a private
 * key by definition, and the account sweep behind the home page's lookup
 * form, which derives up to 256 addresses in one user-driven pass. Every
 * other address and every fingerprint comes from
 * {@link fetchPublicKeyBytes}.
 *
 * @returns The SEP-0005 parent node.
 */
async function getAccountParentNode(): Promise<SLIP10Node> {
  const entropy = await snap.request({
    method: 'snap_getBip32Entropy',
    params: {
      // No `source`: this resolves the *primary* entropy source. MetaMask
      // supports several secret recovery phrases, so which one is primary is
      // an input to every address this snap shows. `bindFingerprint` below
      // is what stops that input changing silently underneath the caches and
      // the stored account registry.
      path: SUBTREE_PATH,
      curve: 'ed25519',
    },
  });
  const node = await SLIP10Node.fromJSON(entropy);
  const fingerprint = fingerprintOf(node.publicKeyBytes);
  // Recorded immutably against the node itself, so work that retained this
  // node across a later phrase change can prove which phrase it derives for.
  nodeFingerprints.set(node, fingerprint);
  await bindFingerprint(fingerprint);
  return node;
}

/**
 * Detects a change of secret recovery phrase and invalidates everything
 * derived from the previous one.
 *
 * {@link addressCache} is memoized by index alone, so without this it would
 * keep answering with addresses from a phrase the wallet no longer uses. The
 * signing path is not exposed to that (it re-derives and compares the result
 * against the address it was asked for, in `deriveSigningKeypair`). The
 * display path is, though: `getActiveAddress` feeds `requestAccess`,
 * `getAddress`, `fund`, and the home page straight from the cache. An address
 * returned there is one a dapp may pay to, so it gets the same treatment as
 * one that is signed for.
 *
 * Called with the fingerprint of whichever key the caller just fetched, the
 * parent node or the subtree's public key alone; see {@link fingerprintOf}.
 *
 * @param fingerprint - The fingerprint of the phrase just observed.
 */
async function bindFingerprint(fingerprint: string): Promise<void> {
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
          // it costs one public-key request, and a request observes the
          // fingerprint once before it resolves anything.
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
 * with it (see {@link bindFingerprint}). That reasoning does not carry over
 * to grants. A grant describes a specific key set, so a failed reconciliation
 * leaves the snap unable to say whether the recorded grants belong to the
 * phrase it is now deriving from, and honouring them anyway is precisely the
 * outcome the binding exists to prevent: consent given for one wallet extended
 * to another. So this refuses, while key derivation and cold signing (which
 * name no account and always show a dialog) keep working.
 *
 * Observing the phrase explicitly, rather than reading an address out of the
 * memo, is what makes the check real. A warm memo would short-circuit the
 * observation entirely: no observation means no {@link bindFingerprint},
 * which means no reconciliation, so neither a transient store failure nor a
 * changed phrase would ever be noticed again. The memo is necessarily warm on
 * exactly the paths that matter, because resolution itself repopulates it.
 * Regression test: `src/handlers/access-guards.test.tsx`, "recovers once the
 * store can be written again".
 *
 * The observation happens on every call, not only while unverified. A
 * verification earned earlier in the execution context describes the phrase
 * that was primary then; MetaMask can change its primary secret recovery
 * phrase while the context stays warm, and a grant must only ever be honoured
 * against the phrase that is primary *now*. Fetching the subtree's public key
 * is what surfaces the current fingerprint, and {@link bindFingerprint}
 * re-reconciles whenever it changed. One `snap_getBip32PublicKey` per
 * grant-gated request is the cost of that guarantee, and it imports no
 * private material: the parent node is fetched only to sign.
 *
 * The state snapshot is read after the observation, because the observation
 * is what settles a pending reconciliation: read before it, `activeAccount`
 * could be an index recorded under a phrase the reconciliation is about to
 * reset. It is then checked to carry the observed fingerprint. Requests
 * overlap, and a concurrent one can observe a newer phrase and reconcile the
 * store to it between this request's reconciliation settling and its read; a
 * snapshot stamped with another fingerprint belongs to another wallet, and
 * reading a grant or an account index out of it would be exactly the
 * cross-wallet authorisation the binding exists to prevent. Refusing here is
 * what lets every caller treat `state` as "the store, as it belongs to
 * `fingerprint`".
 *
 * Resolving the active account afterwards fills {@link addressCache}, so the
 * address lookup every caller does immediately afterwards is a cache hit
 * rather than another round trip.
 *
 * The returned binding carries the fingerprint that was observed rather than
 * whatever is current at return time, so a concurrent change cannot swap in
 * the newer value between the observation and the capture. A caller that
 * goes on to write (a grant, an account reveal, a network or token change)
 * passes it to the state helper, which compares it against the store inside
 * the state lock, so an approval collected for this phrase cannot land in
 * another phrase's state.
 *
 * @returns The confirmed binding: the fingerprint and a state snapshot that
 * belongs to it.
 * @throws An external-service error when the binding cannot be confirmed, or
 * when the phrase changed underneath the request.
 */
export async function ensureEntropyBinding(): Promise<EntropyBinding> {
  const fingerprint = await observeEntropyFingerprint();
  // Another request may have observed a newer phrase while this one waited
  // for its reconciliation; what was observed here no longer describes the
  // wallet, so nothing read under it may be honoured.
  if (contextFingerprint !== fingerprint) {
    throw phraseChangedError();
  }
  if (!bindingVerified) {
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
    await resolveAddresses([activeAccount], fingerprint);
  }
  // Re-checked for the memo-hit path, which awaited nothing since the state
  // read and could otherwise return a binding whose fingerprint a concurrent
  // request has already superseded. (The miss path confirms inside
  // `resolveAddresses`.)
  if (contextFingerprint !== fingerprint) {
    throw phraseChangedError();
  }
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
 * Used only by the account sweep ({@link findAccountIndexByAddress}): every
 * other address comes from a public-key request and never materializes a
 * keypair at all. The sweep derives from a parent node it already holds, so a
 * public-key round trip per index would cost up to {@link MAX_ACCOUNT_INDEX}
 * platform calls where one derivation costs nothing. The keypair it produces
 * is then immediately garbage, but garbage that holds an account secret, and
 * an unmatched search would leave up to {@link MAX_ACCOUNT_INDEX} of them
 * behind without the wipe, none needed for longer than the `publicKey()` call
 * below.
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
 * Resolves the address for each of the given indices from public keys alone,
 * filling the memo along the way.
 *
 * Returns the resolved pairs rather than leaving callers to read them back
 * out of {@link addressCache}: observing the phrase can *clear* the cache
 * (`bindFingerprint` does so when the secret recovery phrase changed), so a
 * caller that decided which indices were missing, awaited, and then re-read
 * the map could read `undefined` for an index it had seen a moment earlier.
 * Returning the values means a future reordering cannot turn that into
 * `undefined` flowing out through `getAccounts` and the home page as though
 * it were an address.
 *
 * Every resolution is bound to a fingerprint, and the binding is enforced on
 * both sides of the fetch. A memo entry is used only while the memo still
 * belongs to that phrase ({@link cachedAddress}). A key fetched to fill a
 * miss answers for whichever phrase is primary at the moment of the fetch,
 * and a public key carries nothing that says which phrase that was, so the
 * phrase is observed again *after* the fetches and the batch is refused
 * unless that observation still matches the binding (and no concurrent
 * request has moved the context on). Between them, a request authorised
 * under one phrase can never cache or return another phrase's addresses.
 * What this cannot see is a phrase changing away and back between the two
 * observations, which would take two user-driven switches inside one
 * platform round trip; the signing path does not rely on this memo (it
 * re-derives and compares), so that window can never produce a signature.
 *
 * @param indices - The account indices to resolve.
 * @param fingerprint - The fingerprint the resolution is bound to.
 * @returns The `{ index, address }` pair for each requested index, in the
 * order given.
 */
async function resolveAddresses(
  indices: number[],
  fingerprint: string,
): Promise<{ index: number; address: string }[]> {
  const missing = [
    ...new Set(
      indices.filter(
        (index) => cachedAddress(index, fingerprint) === undefined,
      ),
    ),
  ];
  if (missing.length > 0) {
    const fetched = await Promise.all(
      missing.map(async (index) => [index, await fetchAddress(index)] as const),
    );
    const observed = await observeEntropyFingerprint();
    if (observed !== fingerprint || contextFingerprint !== fingerprint) {
      throw phraseChangedError();
    }
    // Synchronous from the confirmation above to the writes: no await can
    // let another request clear the memo for a newer phrase in between.
    for (const [index, address] of fetched) {
      addressCache.set(index, address);
    }
  }
  return indices.map((index) => {
    const address = cachedAddress(index, fingerprint);
    if (address === undefined) {
      // Only reachable if the memo was cleared between the confirmation and
      // this read, which the synchronous section above rules out; refuse
      // rather than cast away.
      throw phraseChangedError();
    }
    return { index, address };
  });
}

/**
 * A memoizing getter for the SEP-0005 parent node: fetches on first use,
 * then reuses the same promise, so the account sweep crosses the sandbox
 * boundary with the parent key material at most once.
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
 * Finds which SEP-0005 index derives a given address, or null when none of
 * the derivable indices does.
 *
 * This is what lets a user reach an account they already hold in another
 * SEP-0005 wallet: they know its address, not the index it sits at. The
 * search is purely local derivation over the bounded index range, with no
 * network lookup, so it discloses nothing and cannot be driven by a dapp:
 * only the home page calls it, in response to the user's own input.
 *
 * This is the one display path that imports the parent node rather than
 * asking the platform for public keys: a sweep of up to
 * {@link MAX_ACCOUNT_INDEX} indices would otherwise be that many round trips,
 * and it runs only when the user submits the lookup form. Derivation stops
 * at the first match, and results fill the shared address cache, so a
 * repeated search costs nothing beyond the first.
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
 * has since changed. It is the fingerprint actually observed for this
 * resolution, not whatever is current at return time, so a concurrent phrase
 * change cannot swap in the newer value between the observation and the
 * capture.
 *
 * When the caller holds a binding (every explicit account selection does:
 * selection requires a grant, and the grant check produces one), the
 * resolution is confined to it. The phrase observed here must be the
 * binding's, checked *before* any address is compared, and the registry is
 * read from the binding's snapshot rather than from fresh state. Without
 * that, an origin granted under one phrase could run an explicit-address
 * request across a phrase change and learn, from whether it reached a dialog
 * or was refused, which addresses the *new* wallet holds: the membership
 * oracle that gating selection on a grant exists to close. With it, a phrase
 * change produces the same refusal whatever address was named.
 *
 * Nothing here imports private material: the phrase is observed and the
 * addresses resolved from public keys. The parent node is fetched once, by
 * {@link deriveSigningKeypair}, after the user has approved.
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
  // Observe the phrase before reading state, not after. Observing is what
  // detects a changed secret recovery phrase and settles the persisted-state
  // reconciliation that resets accounts recorded under the old one; a state
  // snapshot taken first could hand this function an account index from the
  // previous phrase, and the dialog would then present (and the wallet sign
  // for) a selection the reset was about to discard.
  const entropyFingerprint = await observeEntropyFingerprint();
  if (binding !== undefined && entropyFingerprint !== binding.fingerprint) {
    throw phraseChangedError();
  }
  const state = binding?.state ?? (await getState());
  if (requestedAddress === undefined) {
    const [active] = await resolveAddresses(
      [state.activeAccount],
      entropyFingerprint,
    );
    if (active === undefined) {
      // `resolveAddresses` answers one pair per requested index; asserted
      // rather than cast away.
      throw new Error('Failed to resolve the active account.');
    }
    return { ...active, entropyFingerprint };
  }

  // Resolve through the address index, so an address the wallet does not hold
  // is rejected without deriving a signing key at all. Repeating an unowned
  // address is then a map lookup rather than a full sweep of every revealed
  // account.
  const owned = await resolveAddresses(state.accounts, entropyFingerprint);
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
 * This is the one place a signing request imports the parent node, and it
 * happens only now, after approval. {@link resolveSigningAccount} worked from
 * public keys, so nothing private was live during the simulation, the
 * Horizon lookups, or however long the user spent reading the dialog; the
 * `m/44'/148'` subtree key crosses the boundary for the signature itself
 * and for nothing else.
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
