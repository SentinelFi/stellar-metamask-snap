import type { FeeBumpTransaction } from '@stellar/stellar-sdk';
import {
  authorizeEntry,
  hash,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { deriveKeypair } from '../keys';
import { invalidRequest, userRejected } from '../rpc/errors';
import {
  SignAuthEntryParams,
  SignMessageParams,
  SignTransactionParams,
  validate,
} from '../rpc/validation';
import { connectOrigin, getActiveNetwork } from '../state';
import { submitTransaction } from '../stellar/horizon';
import { getLatestLedger, sendTransaction } from '../stellar/rpc';
import { collectSafetyWarnings } from '../stellar/safety';
import type { SimulationSummary } from '../stellar/soroban';
import {
  decodeAuthEntry,
  getSorobanOperation,
  simulateForDisplay,
} from '../stellar/soroban';
import { SignAuthEntryDialog, SignMessageDialog } from '../ui/dialogs';
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
): Promise<{
  signedTxXdr: string;
  signerAddress: string;
  hash?: string;
  /** Advisory safety warnings also shown in the dialog. */
  warnings?: string[];
}> {
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

  // Soroban transactions get a display-verification simulation (Sui-snap
  // pattern): resource fee, required auth signers, restore requirements.
  // The transaction itself is never modified — we sign the provided XDR.
  let simulation: SimulationSummary | null = null;
  const isSoroban =
    tx instanceof Transaction && getSorobanOperation(tx) !== null;
  if (isSoroban) {
    simulation = await simulateForDisplay(network.sorobanRpcUrl, request.xdr);
  }

  // Classic transactions get best-effort safety checks (unfunded
  // destinations, SEP-29 memo requirements, multisig weight). Advisory only.
  let warnings: string[] = [];
  if (tx instanceof Transaction && !isSoroban && tx.sequence !== '0') {
    warnings = await collectSafetyWarnings(tx, network, signerAddress);
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
        simulation,
        warnings,
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
  const warningsField = warnings.length > 0 ? { warnings } : {};

  if (request.submit) {
    // Soroban transactions must go through the RPC; classic ones use
    // Horizon's synchronous endpoint.
    if (isSoroban) {
      const sent = await sendTransaction(network.sorobanRpcUrl, signedTxXdr);
      return { signedTxXdr, signerAddress, hash: sent.hash, ...warningsField };
    }
    const { hash: txHash } = await submitTransaction(
      network.horizonUrl,
      signedTxXdr,
    );
    return { signedTxXdr, signerAddress, hash: txHash, ...warningsField };
  }

  return { signedTxXdr, signerAddress, ...warningsField };
}

/**
 * `signAuthEntry` — sign a Soroban authorization entry (SEP-43). Decodes the
 * entry, shows the invocation tree, and signs the `HashIdPreimage` via the
 * SDK's `authorizeEntry`, preserving the entry's own expiration ledger (or
 * defaulting to latest + ~5 minutes when unset).
 *
 * @param origin - The requesting dapp origin.
 * @param params - `{ authEntry, networkPassphrase?, address? }`.
 * @returns The signed entry XDR and signer address.
 */
export async function signAuthEntry(
  origin: string,
  params: unknown,
): Promise<{ signedAuthEntry: string; signerAddress: string }> {
  const request = validate(params, SignAuthEntryParams);
  const network = await getActiveNetwork();

  if (
    request.networkPassphrase !== undefined &&
    request.networkPassphrase !== network.networkPassphrase
  ) {
    throw invalidRequest(
      `Network mismatch: the wallet is on ${network.name}. Ask the user to switch networks (setNetwork) or use the matching passphrase.`,
    );
  }

  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(request.authEntry, 'base64');
  } catch {
    throw invalidRequest('Could not parse the authorization entry XDR.');
  }

  const decoded = decodeAuthEntry(entry);
  if (decoded.credentialsType !== 'address') {
    throw invalidRequest(
      'This entry uses source-account credentials; it is authorized by the transaction signature and needs no separate signature.',
    );
  }

  const keypair = await deriveKeypair(0);
  const signerAddress = keypair.publicKey();
  if (request.address !== undefined && request.address !== signerAddress) {
    throw invalidRequest('Unknown address: this wallet cannot sign for it.');
  }
  if (decoded.address !== signerAddress) {
    throw invalidRequest(
      'The authorization entry names a different account than this wallet.',
    );
  }

  // Preserve the dapp's expiration; when unset, default to ~5 minutes.
  let validUntil = decoded.signatureExpirationLedger ?? 0;
  if (validUntil === 0) {
    validUntil = (await getLatestLedger(network.sorobanRpcUrl)) + 60;
  }

  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <SignAuthEntryDialog
          origin={origin}
          network={network.name}
          address={signerAddress}
          invocations={decoded.invocations}
          nonce={decoded.nonce ?? '0'}
          signatureExpirationLedger={validUntil}
        />
      ),
    },
  });
  if (!approved) {
    throw userRejected();
  }

  await connectOrigin(origin);

  const signed = await authorizeEntry(
    entry,
    keypair,
    validUntil,
    network.networkPassphrase,
  );
  return {
    signedAuthEntry: signed.toXDR('base64'),
    signerAddress,
  };
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
