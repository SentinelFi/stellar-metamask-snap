import { SLIP10Node } from '@metamask/key-tree';
import { Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { invalidRequest } from '../rpc/errors';
import { getState, MAX_ACCOUNT_INDEX } from '../state';

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
      path: ['m', "44'", "148'"],
      curve: 'ed25519',
    },
  });
  return SLIP10Node.fromJSON(entropy);
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

  return Keypair.fromRawEd25519Seed(Buffer.from(child.privateKeyBytes));
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
 * Public addresses by account index, memoized for this execution context.
 *
 * Addresses are public, so this holds no secret. It exists so that resolving
 * a dapp-supplied address does not have to derive every revealed account on
 * every request: without it, repeatedly submitting an address the wallet does
 * not hold forces a full sweep each time, before any dialog or throttle can
 * intervene.
 */
const addressCache = new Map<number, string>();

/** Clears the memoized addresses. Test hook. */
export function resetAddressCache(): void {
  addressCache.clear();
}

/**
 * Fills the address cache for any of the given indices not already known,
 * deriving the parent node at most once.
 *
 * @param indices - The account indices to cache.
 */
async function cacheAddresses(indices: number[]): Promise<void> {
  const missing = indices.filter((index) => !addressCache.has(index));
  if (missing.length === 0) {
    return;
  }
  const node = await getAccountParentNode();
  await Promise.all(
    missing.map(async (index) => {
      addressCache.set(index, (await deriveFromNode(node, index)).publicKey());
    }),
  );
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
 * @returns `{ index, address }` for each account in state.
 */
export async function getOwnedAccounts(): Promise<
  { index: number; address: string }[]
> {
  const state = await getState();
  await cacheAddresses(state.accounts);
  return state.accounts.map((index) => ({
    index,
    address: addressCache.get(index) as string,
  }));
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
  await cacheAddresses(state.accounts);
  const index = state.accounts.find(
    (candidate) => addressCache.get(candidate) === requestedAddress,
  );
  if (index === undefined) {
    throw invalidRequest('Unknown address: this wallet does not hold it.');
  }

  const keypair = await deriveKeypair(index);
  // The cache is derived state; never sign on it without confirming the key
  // it pointed at really is the address that was asked for.
  if (keypair.publicKey() !== requestedAddress) {
    addressCache.clear();
    throw invalidRequest('Unknown address: this wallet does not hold it.');
  }
  return { keypair, index };
}
