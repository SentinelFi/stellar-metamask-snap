import type { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk';
import { hash, TransactionBuilder } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { deriveKeypair } from '../keys';
import { invalidRequest, userRejected } from '../rpc/errors';
import {
  SignMessageParams,
  SignTransactionParams,
  validate,
} from '../rpc/validation';
import { connectOrigin, getActiveNetwork } from '../state';
import { submitTransaction } from '../stellar/horizon';
import { SignMessageDialog } from '../ui/dialogs';
import { buildSignTransactionDialog } from '../ui/transaction';

/** SEP-53 signed-message prefix. */
const SIGNED_MESSAGE_PREFIX = 'Stellar Signed Message:\n';

/**
 * `signTransaction` — parse the XDR (the only source of truth), show the
 * review dialog, sign with the SEP-5 key, and optionally submit to Horizon.
 *
 * @param origin - The requesting dapp origin.
 * @param params - `{ xdr, networkPassphrase?, address?, submit? }`.
 * @returns The signed envelope and signer address (plus `hash` if submitted).
 */
export async function signTransaction(
  origin: string,
  params: unknown,
): Promise<{ signedTxXdr: string; signerAddress: string; hash?: string }> {
  const request = validate(params, SignTransactionParams);
  const network = await getActiveNetwork();

  if (
    request.networkPassphrase !== undefined &&
    request.networkPassphrase !== network.networkPassphrase
  ) {
    throw invalidRequest(
      `Network mismatch: the wallet is on ${network.name}. Ask the user to switch networks (setNetwork) or use the matching passphrase.`,
    );
  }

  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXDR(request.xdr, network.networkPassphrase);
  } catch {
    throw invalidRequest('Could not parse the transaction XDR.');
  }

  const keypair = await deriveKeypair(0);
  const signerAddress = keypair.publicKey();
  if (request.address !== undefined && request.address !== signerAddress) {
    throw invalidRequest('Unknown address: this wallet cannot sign for it.');
  }

  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: buildSignTransactionDialog({
        origin,
        network: network.name,
        tx,
        xdr: request.xdr,
      }),
    },
  });
  if (!approved) {
    throw userRejected();
  }

  // An approved signature is also consent to be connected.
  await connectOrigin(origin);

  tx.sign(keypair);
  const signedTxXdr = tx.toXDR();

  if (request.submit) {
    const { hash: txHash } = await submitTransaction(
      network.horizonUrl,
      signedTxXdr,
    );
    return { signedTxXdr, signerAddress, hash: txHash };
  }

  return { signedTxXdr, signerAddress };
}

/**
 * `signMessage` — SEP-53: sign SHA-256("Stellar Signed Message:\n" + msg).
 *
 * @param origin - The requesting dapp origin.
 * @param params - `{ message, address? }`.
 * @returns The base64 signature and signer address.
 */
export async function signMessage(
  origin: string,
  params: unknown,
): Promise<{ signedMessage: string; signerAddress: string }> {
  const request = validate(params, SignMessageParams);

  const keypair = await deriveKeypair(0);
  const signerAddress = keypair.publicKey();
  if (request.address !== undefined && request.address !== signerAddress) {
    throw invalidRequest('Unknown address: this wallet cannot sign for it.');
  }

  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <SignMessageDialog
          origin={origin}
          address={signerAddress}
          message={request.message}
        />
      ),
    },
  });
  if (!approved) {
    throw userRejected();
  }

  await connectOrigin(origin);

  const payload = hash(
    Buffer.concat([
      Buffer.from(SIGNED_MESSAGE_PREFIX, 'utf8'),
      Buffer.from(request.message, 'utf8'),
    ]),
  );
  const signature = keypair.sign(payload);

  return { signedMessage: signature.toString('base64'), signerAddress };
}
