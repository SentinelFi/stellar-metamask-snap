import { SLIP10Node } from '@metamask/key-tree';
import { Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { invalidRequest } from '../rpc/errors';
import { getState } from '../state';

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
  const entropy = await snap.request({
    method: 'snap_getBip32Entropy',
    params: {
      path: ['m', "44'", "148'"],
      curve: 'ed25519',
    },
  });

  const node = await SLIP10Node.fromJSON(entropy);
  const child = await node.derive([`slip10:${index}'`]);

  if (!child.privateKeyBytes) {
    throw new Error('Failed to derive a private key.');
  }

  return Keypair.fromRawEd25519Seed(Buffer.from(child.privateKeyBytes));
}

/**
 * The public address for a SEP-0005 account index.
 *
 * @param index - The account index.
 * @returns The `G...` address.
 */
export async function getAddressForIndex(index: number): Promise<string> {
  const keypair = await deriveKeypair(index);
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
  return Promise.all(
    state.accounts.map(async (index) => ({
      index,
      address: await getAddressForIndex(index),
    })),
  );
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
  for (const index of state.accounts) {
    const keypair = await deriveKeypair(index);
    if (keypair.publicKey() === requestedAddress) {
      return { keypair, index };
    }
  }
  throw invalidRequest('Unknown address: this wallet does not hold it.');
}
