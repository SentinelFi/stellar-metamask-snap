import { SLIP10Node } from '@metamask/key-tree';
import { hash, Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { invalidRequest } from '../rpc/errors';
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
 * Clears the memoized addresses and the entropy binding recorded for this
 * execution context. Test hook.
 */
export function resetAddressCache(): void {
  addressCache.clear();
  contextFingerprint = null;
  bindingReconciliation = null;
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
  const fingerprint = hash(Buffer.from(node.publicKey, 'hex')).toString('hex');
  if (contextFingerprint !== null && contextFingerprint !== fingerprint) {
    addressCache.clear();
  }
  contextFingerprint = fingerprint;
  // The persisted reconciliation costs a state read and is only meaningful
  // once per execution context, so it runs on the first key use and not on
  // every parent-node fetch.
  // Best effort, for the same reason the signing handlers record their grant
  // best effort: this is bookkeeping *about* the key material, and a store
  // that cannot be written must not take key derivation down with it. That
  // would turn a state-write failure into an inability to sign, which is
  // strictly worse than a fingerprint recorded one context later. The
  // in-context cache invalidation above does not depend on it.
  bindingReconciliation ??= reconcileEntropyBinding(fingerprint).then(
    (reset) => {
      if (reset) {
        addressCache.clear();
      }
      return undefined;
    },
    () => {
      // Clear the latch so the next key use retries. Retrying is cheap:
      // `lazyAccountParentNode` already collapses a request's parent-node
      // fetches into one, so this costs at most one extra attempt per request,
      // not one per derivation.
      bindingReconciliation = null;
      // Drop the cache as well. Nothing derived from the store is known-good
      // for this fingerprint while the binding is unverified, and the display
      // path (`getWalletAddress` and, through it, `requestAccess`,
      // `getAddress`, `fund`, and the home page) reads addresses straight out
      // of it. Key derivation itself is untouched, which is the property the
      // best-effort treatment exists to protect.
      addressCache.clear();
      return undefined;
    },
  );
  await bindingReconciliation;
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
      const address = (
        await deriveFromNode(node ?? (await getNode()), index)
      ).publicKey();
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
      candidate = (await deriveFromNode(await getNode(), index)).publicKey();
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
  const keypair = await deriveKeypair(index);
  addressCache.set(index, keypair.publicKey());
  return keypair.publicKey();
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
 * Resolves the SEP-43 `address` option to an owned account's keypair
 * (Freighter parity: "switch to that account if available"), staying
 * fail-closed: only indices the user has revealed (`state.accounts`) are
 * ever derived and compared, so an origin cannot probe or sign for an
 * arbitrary never-revealed index. No selection means the active account.
 *
 * @param requestedAddress - The `address` option, when the dapp sent one.
 * @returns The signing keypair and its account index.
 * @throws An invalid-request error when the address is not held.
 */
export async function resolveSigningKeypair(
  requestedAddress?: string,
): Promise<{ keypair: Keypair; index: number }> {
  const state = await getState();
  if (requestedAddress === undefined) {
    return {
      keypair: await deriveKeypair(state.activeAccount),
      index: state.activeAccount,
    };
  }

  // Resolve through the address index, so an address the wallet does not hold
  // is rejected without deriving anything. Repeating an unowned address is
  // then a map lookup rather than a full sweep of every revealed account.
  // One shared parent-node getter covers both the cache fill and the final
  // derivation, so the parent key material crosses the sandbox boundary at
  // most once per request.
  const getNode = lazyAccountParentNode();
  const owned = await resolveAddresses(state.accounts, getNode);
  const match = owned.find((entry) => entry.address === requestedAddress);
  if (match === undefined) {
    throw invalidRequest('Unknown address: this wallet does not hold it.');
  }
  const { index } = match;

  const keypair = await deriveFromNode(await getNode(), index);
  // The cache is derived state; never sign on it without confirming the key
  // it pointed at really is the address that was asked for.
  if (keypair.publicKey() !== requestedAddress) {
    addressCache.clear();
    throw invalidRequest('Unknown address: this wallet does not hold it.');
  }
  return { keypair, index };
}
