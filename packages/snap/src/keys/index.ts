import { SLIP10Node } from '@metamask/key-tree';
import { hash, Keypair } from '@stellar/stellar-sdk/base';
import { Buffer } from 'buffer';

import { externalServiceError, invalidRequest } from '../rpc/errors';
import type { SnapState } from '../state';
import { getState, MAX_ACCOUNT_INDEX, reconcileEntropyBinding } from '../state';

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
 * display path is, though: `getWalletAddress` feeds `requestAccess`,
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
    reconciledFingerprint = fingerprint;
    // Unverified until the reconciliation for *this* fingerprint settles: a
    // verification earned under the previous phrase does not carry over.
    bindingVerified = false;
    bindingReconciliation = reconcileEntropyBinding(fingerprint).then(
      (reset) => {
        // Guarded, because a settle can arrive after yet another fingerprint
        // has superseded this one; only the current reconciliation may speak
        // for the binding.
        if (reconciledFingerprint === fingerprint) {
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
        if (reconciledFingerprint === fingerprint) {
          bindingVerified = false;
          // Clear the latch so the next key use retries. Retrying is cheap:
          // `lazyAccountParentNode` already collapses a request's parent-node
          // fetches into one, so this costs at most one extra attempt per
          // request, not one per derivation.
          bindingReconciliation = null;
          reconciledFingerprint = null;
        }
        // Drop the cache as well. Nothing derived from the store is
        // known-good for this fingerprint while the binding is unverified,
        // and the display path (`getWalletAddress` and, through it,
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
 * Fetching the parent node explicitly, rather than calling
 * {@link getWalletAddress}, is what makes the check real. That helper reads
 * {@link addressCache} first, and a warm cache short-circuits the fetch
 * entirely: no fetch means no {@link bindToEntropySource}, which means no
 * reconciliation, so neither a transient store failure nor a changed phrase
 * would ever be observed again. The cache is necessarily warm on exactly the
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
 * Deriving the active account afterwards, rather than only fetching the node,
 * fills {@link addressCache}, so the address lookup every caller does
 * immediately afterwards is a cache hit rather than a second crossing of the
 * sandbox boundary with the parent key material. The state read happens after
 * the fetch, because the fetch is what settles a pending reconciliation: read
 * before it, `activeAccount` could be an index recorded under a phrase the
 * reconciliation is about to reset.
 *
 * @throws An external-service error when the binding cannot be confirmed.
 */
export async function ensureEntropyBinding(): Promise<void> {
  const node = await getAccountParentNode();
  if (!bindingVerified) {
    throw externalServiceError(
      'The wallet could not confirm which secret recovery phrase this snap ' +
        'stored its data under, so connected-site permissions cannot be used ' +
        'right now. Try again shortly.',
    );
  }
  const { activeAccount } = await getState();
  if (!addressCache.has(activeAccount)) {
    addressCache.set(activeAccount, await deriveAddress(node, activeAccount));
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
 * @param node - The SEP-0005 parent node.
 * @param index - The SEP-0005 account index.
 * @returns The `G...` address.
 */
async function deriveAddress(node: SLIP10Node, index: number): Promise<string> {
  const keypair = await deriveFromNode(node, index);
  try {
    return keypair.publicKey();
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
 * @param indices - The account indices to resolve.
 * @param getNode - The parent-node getter; callers that also derive a key
 * afterwards pass their own so the fetch is shared across both steps.
 * @returns The `{ index, address }` pair for each requested index, in the
 * order given.
 */
async function resolveAddresses(
  indices: number[],
  getNode: () => Promise<SLIP10Node> = lazyAccountParentNode(),
): Promise<{ index: number; address: string }[]> {
  // Fetch the node (and settle any cache invalidation it triggers) before
  // reading the memo, so every read below observes the post-binding cache.
  const node = indices.some((index) => !addressCache.has(index))
    ? await getNode()
    : null;
  return Promise.all(
    indices.map(async (index) => {
      const cached = addressCache.get(index);
      if (cached !== undefined) {
        return { index, address: cached };
      }
      const address = await deriveAddress(node ?? (await getNode()), index);
      addressCache.set(index, address);
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
      candidate = await deriveAddress(await getNode(), index);
      addressCache.set(index, candidate);
    }
    if (candidate === address) {
      return index;
    }
  }
  return null;
}

/**
 * The public address for a SEP-0005 account index.
 *
 * @param index - The account index.
 * @returns The `G...` address.
 */
export async function getAddressForIndex(index: number): Promise<string> {
  const cached = addressCache.get(index);
  if (cached !== undefined) {
    return cached;
  }
  const address = await deriveAddress(await getAccountParentNode(), index);
  addressCache.set(index, address);
  return address;
}

/**
 * The active account's public address.
 *
 * @returns The `G...` address.
 */
export async function getWalletAddress(): Promise<string> {
  const state = await getState();
  return getAddressForIndex(state.activeAccount);
}

/**
 * Every revealed account with its address, in index order.
 *
 * @param state - An already-read state snapshot, when the caller has one.
 * Every `getState()` is a separate `snap_manageState` decrypt round-trip, so
 * a caller that has already read state (the home page reads it to resolve the
 * active account and network) passes it here rather than paying for a second
 * read of the same value. Omitting it reads fresh state, as before.
 * @returns `{ index, address }` for each account in state.
 */
export async function getOwnedAccounts(
  state?: SnapState,
): Promise<{ index: number; address: string }[]> {
  const resolved = state ?? (await getState());
  return resolveAddresses(resolved.accounts);
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
 * @param requestedAddress - The `address` option, when the dapp sent one.
 * @returns The signing account's index and address.
 * @throws An invalid-request error when the address is not held.
 */
export async function resolveSigningAccount(
  requestedAddress?: string,
): Promise<{ index: number; address: string }> {
  // Fetch the parent node before reading state, not after. Fetching is what
  // detects a changed secret recovery phrase and settles the persisted-state
  // reconciliation that resets accounts recorded under the old one; a state
  // snapshot taken first could hand this function an account index from the
  // previous phrase, and the dialog would then present (and the wallet sign
  // for) a selection the reset was about to discard. The getter is shared
  // with the address resolution below, so this stays one fetch per request.
  const getNode = lazyAccountParentNode();
  await getNode();
  const state = await getState();
  if (requestedAddress === undefined) {
    const [active] = await resolveAddresses([state.activeAccount], getNode);
    if (active === undefined) {
      // `resolveAddresses` answers one pair per requested index; asserted
      // rather than cast away.
      throw new Error('Failed to derive the active account.');
    }
    return active;
  }

  // Resolve through the address index, so an address the wallet does not hold
  // is rejected without deriving a signing key at all. Repeating an unowned
  // address is then a map lookup rather than a full sweep of every revealed
  // account.
  const owned = await resolveAddresses(state.accounts, getNode);
  const match = owned.find((entry) => entry.address === requestedAddress);
  if (match === undefined) {
    throw invalidRequest('Unknown address: this wallet does not hold it.');
  }
  return match;
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
