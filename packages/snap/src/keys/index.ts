import { SLIP10Node } from '@metamask/key-tree';
import { Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

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
 * The wallet's primary (index 0) public address.
 *
 * @returns The `G...` address.
 */
export async function getWalletAddress(): Promise<string> {
  const keypair = await deriveKeypair(0);
  return keypair.publicKey();
}
