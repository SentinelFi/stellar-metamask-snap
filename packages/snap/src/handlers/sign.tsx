import { SnapError } from '@metamask/snaps-sdk';
import type { FeeBumpTransaction } from '@stellar/stellar-sdk';
import {
  authorizeEntry,
  hash,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { resolveSigningKeypair } from '../keys';
import {
  externalServiceError,
  invalidRequest,
  userRejected,
} from '../rpc/errors';
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
  boundAuthExpiration,
  decodeAuthEntry,
  decodeHostFunction,
  findUndisplayableAuthEntry,
  getSorobanOperation,
  hasMisplacedSorobanOperation,
  simulateForDisplay,
} from '../stellar/soroban';
import { SignAuthEntryDialog, SignMessageDialog } from '../ui/dialogs';
import { containsHiddenCharacters } from '../ui/format';
import {
  buildSignTransactionDialog,
  SUPPORTED_OPERATION_TYPES,
} from '../ui/transaction';

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
  /** Soroban RPC acceptance status when submitted (PENDING/DUPLICATE). */
  status?: string;
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

  // SEP-43 `address` option: resolve to an owned, revealed account (or the
  // active account when absent); a non-owned address is rejected.
  const { keypair, index: accountIndex } = await resolveSigningKeypair(
    request.address,
  );
  const signerAddress = keypair.publicKey();

  // Resolve the transaction that carries the operations: for a fee bump that
  // is the inner transaction, so a fee-bumped Soroban tx is still recognised
  // as Soroban and gets the same review and RPC routing.
  const innerTx = tx instanceof Transaction ? tx : tx.innerTransaction;
  const sorobanOperation = getSorobanOperation(innerTx);
  const isSoroban = sorobanOperation !== null;

  // A Soroban operation mixed into a multi-operation transaction is invalid
  // at the protocol level and would otherwise be misclassified as classic,
  // skipping simulation. Reject it outright.
  if (hasMisplacedSorobanOperation(innerTx)) {
    throw invalidRequest(
      'A Soroban operation must be the only operation in its transaction. This transaction can never execute and will not be signed.',
    );
  }

  // Fail closed: a transaction whose effects cannot be displayed
  // faithfully must not be approvable. A warning over raw XDR is not a
  // usable review mechanism.
  const unsupportedTypes = [
    ...new Set(
      innerTx.operations
        .map((operation) => operation.type)
        .filter((type) => !SUPPORTED_OPERATION_TYPES.has(type)),
    ),
  ];
  if (unsupportedTypes.length > 0) {
    throw invalidRequest(
      `This transaction contains operation types the snap cannot display faithfully (${unsupportedTypes.join(
        ', ',
      )}) and cannot be reviewed. Signing is refused.`,
    );
  }
  if (
    sorobanOperation?.type === 'invokeHostFunction' &&
    decodeHostFunction(sorobanOperation.func).kind === 'unknown'
  ) {
    throw invalidRequest(
      'This transaction contains a host function the snap cannot display faithfully. Signing is refused.',
    );
  }
  // Embedded auth entries with source-account credentials are authorized by
  // the envelope signature itself, so they must be as reviewable as a
  // standalone signAuthEntry request: fail closed on anything undecodable
  // or unsupported instead of degrading to an inline marker.
  if (
    sorobanOperation?.type === 'invokeHostFunction' &&
    findUndisplayableAuthEntry(sorobanOperation.auth ?? []) !== null
  ) {
    throw invalidRequest(
      'This transaction embeds an authorization entry the snap cannot display faithfully. Signing is refused.',
    );
  }

  // Soroban transactions get a display-verification simulation (Sui-snap
  // pattern): resource fee, required auth signers, restore requirements.
  // The transaction itself is never modified — we sign the provided XDR.
  let simulation: SimulationSummary | null = null;
  if (isSoroban) {
    // Simulate the operation-bearing envelope (the inner tx for a fee bump).
    const sorobanXdr =
      tx instanceof Transaction ? request.xdr : innerTx.toXDR();
    simulation = await simulateForDisplay(network.sorobanRpcUrl, sorobanXdr);
  }

  // Classic transactions get best-effort safety checks (unfunded
  // destinations, SEP-29 memo requirements, multisig weight). Advisory only.
  // Fee bumps get the same checks against their inner transaction.
  let warnings: string[] = [];
  if (!isSoroban && innerTx.sequence !== '0') {
    warnings = await collectSafetyWarnings(innerTx, network, signerAddress);
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
        signingAddress: signerAddress,
        accountIndex,
        simulation,
        warnings,
        submit: Boolean(request.submit),
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
    try {
      // Soroban transactions must go through the RPC; classic ones use
      // Horizon's synchronous endpoint.
      if (isSoroban) {
        const sent = await sendTransaction(network.sorobanRpcUrl, signedTxXdr);
        // sendTransaction is asynchronous: PENDING/DUPLICATE mean accepted,
        // but ERROR/TRY_AGAIN_LATER are failures that must not be reported as
        // a successful hash.
        if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
          throw externalServiceError(
            `Soroban submission ${sent.status === 'ERROR' ? 'was rejected' : 'was throttled (try again later)'}.`,
          );
        }
        return {
          signedTxXdr,
          signerAddress,
          hash: sent.hash,
          status: sent.status,
          ...warningsField,
        };
      }
      const { hash: txHash } = await submitTransaction(
        network.horizonUrl,
        signedTxXdr,
      );
      return { signedTxXdr, signerAddress, hash: txHash, ...warningsField };
    } catch (error) {
      // The user did sign — surface the signature alongside the submission
      // failure. On a Horizon timeout the transaction may still land, so
      // the dapp needs the envelope to poll or retry.
      if (error instanceof SnapError) {
        const data =
          typeof error.data === 'object' &&
          error.data !== null &&
          !Array.isArray(error.data)
            ? error.data
            : {};
        throw new SnapError(error.message, {
          ...data,
          signedTxXdr,
          signerAddress,
        });
      }
      throw error;
    }
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

  let decoded: ReturnType<typeof decodeAuthEntry>;
  try {
    decoded = decodeAuthEntry(entry);
  } catch {
    throw invalidRequest('Could not decode the authorization entry.');
  }
  if (decoded.credentialsType === 'sourceAccount') {
    throw invalidRequest(
      'This entry uses source-account credentials; it is authorized by the transaction signature and needs no separate signature.',
    );
  }
  // Fail closed: an entry containing credential or function variants
  // the snap cannot display faithfully must not be signable.
  if (decoded.credentialsType !== 'address' || decoded.unsupported) {
    throw invalidRequest(
      'This authorization entry contains a credential or function type the snap cannot display faithfully. Signing is refused.',
    );
  }

  // The entry itself names the authorizing account, so it selects the
  // signing account — resolved among owned, revealed accounts only. An
  // explicit `address` option must agree with the entry.
  if (request.address !== undefined && request.address !== decoded.address) {
    throw invalidRequest(
      'The address option does not match the account named by the authorization entry.',
    );
  }
  let signer: Awaited<ReturnType<typeof resolveSigningKeypair>>;
  try {
    signer = await resolveSigningKeypair(decoded.address);
  } catch {
    throw invalidRequest(
      'The authorization entry names a different account than this wallet.',
    );
  }
  const { keypair, index: accountIndex } = signer;
  const signerAddress = keypair.publicKey();

  // Bound the signature lifetime against the current ledger: reject
  // an already-expired entry and cap how far in the future it may reach, so
  // the user cannot unknowingly grant a very long-lived authorization. When
  // the ledger cannot be fetched, a nonzero expiry passes through unverified
  // (mirrors how simulation failures degrade — warn, never silently pass).
  let latestLedger: number | null = null;
  try {
    latestLedger = await getLatestLedger(network.sorobanRpcUrl);
  } catch {
    latestLedger = null;
  }

  const bounded = boundAuthExpiration(
    decoded.signatureExpirationLedger ?? 0,
    latestLedger,
  );
  if (!bounded.ok) {
    if (bounded.reason === 'expired') {
      throw invalidRequest('This authorization entry has already expired.');
    }
    if (bounded.reason === 'tooLong') {
      throw invalidRequest(
        'This authorization would stay valid for too long. Ask the site for a shorter expiration.',
      );
    }
    throw externalServiceError(
      'Could not reach the Stellar RPC to set an authorization expiry.',
    );
  }
  const { validUntil, ledgersRemaining } = bounded;

  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <SignAuthEntryDialog
          origin={origin}
          network={network.name}
          address={signerAddress}
          accountIndex={accountIndex}
          invocations={decoded.invocations}
          nonce={decoded.nonce ?? '0'}
          signatureExpirationLedger={validUntil}
          ledgersRemaining={ledgersRemaining}
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

  const { keypair, index: accountIndex } = await resolveSigningKeypair(
    request.address,
  );
  const signerAddress = keypair.publicKey();

  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <SignMessageDialog
          origin={origin}
          address={signerAddress}
          accountIndex={accountIndex}
          message={request.message}
          hasHiddenCharacters={containsHiddenCharacters(request.message)}
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
