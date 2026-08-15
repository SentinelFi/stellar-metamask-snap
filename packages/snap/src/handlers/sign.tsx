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

import { assertConnected } from './account';
import { resolveSigningKeypair } from '../keys';
import {
  externalServiceError,
  invalidRequest,
  userRejected,
} from '../rpc/errors';
import { takePredialogBudget } from '../rpc/limiter';
import { clearDialogRejections, recordDialogOpened } from '../rpc/throttle';
import {
  SignAuthEntryParams,
  SignMessageParams,
  SignTransactionParams,
  validate,
} from '../rpc/validation';
import { connectOrigin, getActiveNetwork, isOriginConnected } from '../state';
import type { NetworkConfig } from '../state/networks';
import { getHorizonLatestLedger, submitTransaction } from '../stellar/horizon';
import { getLatestLedger, sendTransaction } from '../stellar/rpc';
import {
  collectFeeSourceWarnings,
  collectSafetyWarnings,
} from '../stellar/safety';
import type { SimulationSummary } from '../stellar/soroban';
import {
  boundAuthExpiration,
  decodeAuthEntry,
  decodeHostFunction,
  findUndisplayableAuthEntry,
  findUndisplayableFootprint,
  getSorobanData,
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
 * Requires the caller to state which network it means, on the network where
 * being wrong is expensive.
 *
 * `networkPassphrase` is optional in SEP-43, and when it is omitted there is
 * nothing to mismatch: the envelope is parsed and hashed against whatever
 * network the wallet happens to be on. The asymmetry is directional. A site
 * intending PUBLIC while the wallet sits on TESTNET gets a signature that is
 * worthless on mainnet, which is the safe direction. A site intending TESTNET
 * while the wallet sits on PUBLIC gets a *mainnet-valid* signature, and no
 * party has stated a network anywhere in the exchange.
 *
 * The mainnet banner in the review dialog used to be the only defence against
 * that, and it is a weak one for this specific case: the user is not being
 * asked to evaluate a claim the snap made, but to notice a network *they* set
 * in an earlier session and that the site never mentioned. Nothing in the
 * exchange creates the expectation that this is the request worth re-checking.
 *
 * Requiring the field only on PUBLIC keeps test-network ergonomics exactly as
 * they were, so no development workflow changes, and costs a conformant
 * mainnet site one field it necessarily already has: it built the envelope
 * with that passphrase.
 *
 * @param network - The active network config.
 * @param networkPassphrase - The passphrase the caller supplied, if any.
 * @throws An invalid-request error when PUBLIC is active and none was given.
 */
function assertNetworkStated(
  network: NetworkConfig,
  networkPassphrase: string | undefined,
): void {
  if (network.name === 'PUBLIC' && networkPassphrase === undefined) {
    throw invalidRequest(
      'A network passphrase is required for signatures on PUBLIC. Send ' +
        'networkPassphrase so the wallet can confirm that this site and the ' +
        'wallet agree on the network before a mainnet signature is produced.',
    );
  }
}

/**
 * Records the durable connection grant an approved signature implies, without
 * letting a failure to record it undo the signature.
 *
 * The grant is ancillary: it saves the origin a later `requestAccess` round
 * trip. The signature is what the user actually approved. Awaiting
 * `connectOrigin` unguarded coupled the two in the wrong direction, since any
 * state-write failure between approval and `tx.sign()` would surface as a
 * generic internal error, consuming the user's approval and returning nothing.
 * A missing grant is self-correcting (the next `requestAccess` records it);
 * a lost signature is not.
 *
 * @param origin - The requesting dapp origin.
 */
async function recordGrantBestEffort(origin: string): Promise<void> {
  await connectOrigin(origin).catch(() => undefined);
}

/**
 * Gates account selection on a standing connection grant.
 *
 * Signing itself stays available to unconnected origins (cold signing with
 * the active account is deliberate, Freighter-parity behavior), but choosing
 * which account signs is not: resolution outcomes are observable, so an
 * ungated selection lets any origin test arbitrary addresses against the
 * wallet and learn which ones it holds. That is precisely the address
 * linkage `getAccounts` is connection-gated to prevent.
 *
 * Every explicit address requires the grant — including one that happens to
 * equal the active account. Exempting the active address would let an
 * unconnected origin distinguish "this guess is the active account" (request
 * proceeds to a dialog) from "it is not" (immediate rejection): a
 * membership probe. Cold signing remains possible only by omitting the
 * address entirely, which reveals nothing.
 *
 * The grant is checked before the address is resolved, so a caller without
 * one gets the same error whether or not the wallet holds the address.
 *
 * @param origin - The requesting dapp origin.
 * @param requestedAddress - The selected address, when one was named.
 */
async function assertAccountSelectionAllowed(
  origin: string,
  requestedAddress?: string,
): Promise<void> {
  if (requestedAddress === undefined) {
    return;
  }
  await assertConnected(origin);
}

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
  // Read once, before any pre-dialog lookup. A standing grant decides which
  // share of the global pre-dialog budget this request's advisory lookups
  // draw on, so that a cold-callable origin rotating subdomains cannot starve
  // connected sites of their safety checks (src/rpc/limiter.ts).
  const connected = await isOriginConnected(origin);

  assertNetworkStated(network, request.networkPassphrase);
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
  await assertAccountSelectionAllowed(origin, request.address);
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

  // A sequence-0 transaction (typically a SEP-10 login challenge) can never
  // execute on-chain, and its review dialog says exactly that — so honoring
  // `submit` would contradict the disclosure the user approved. Reject the
  // combination instead of broadcasting a doomed envelope.
  if (request.submit && innerTx.sequence === '0') {
    throw invalidRequest(
      'A sequence-0 transaction can never execute on-chain and cannot be submitted. Request a signature without the submit option.',
    );
  }

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
  if (sorobanOperation?.type === 'invokeHostFunction') {
    const hostFunction = decodeHostFunction(sorobanOperation.func);
    if (hostFunction.kind === 'unknown') {
      throw invalidRequest(
        'This transaction contains a host function the snap cannot display faithfully. Signing is refused.',
      );
    }
    // Fail closed on rendering limits too: an argument shown as "…more" or
    // an opaque label is undisclosed signed semantics, exactly like a
    // truncated authorization entry.
    if (hostFunction.truncated) {
      throw invalidRequest(
        'This transaction contains contract-call values too large or deeply nested to display in full. Signing is refused.',
      );
    }
  }
  // Embedded auth entries with source-account credentials are authorized by
  // the envelope signature itself, so they must be as reviewable as a
  // standalone signAuthEntry request: fail closed on anything undecodable,
  // unsupported, or too large to display in full instead of degrading to an
  // inline truncation marker.
  if (sorobanOperation?.type === 'invokeHostFunction') {
    const undisplayable = findUndisplayableAuthEntry(
      sorobanOperation.auth ?? [],
    );
    if (undisplayable === 'truncated') {
      throw invalidRequest(
        'This transaction embeds authorization data too large or deeply nested to display in full. Signing is refused.',
      );
    }
    if (undisplayable !== null) {
      throw invalidRequest(
        'This transaction embeds an authorization entry the snap cannot display faithfully. Signing is refused.',
      );
    }
  }

  // The footprint bounds the transaction's entire signed state-access scope:
  // two envelopes can differ only in footprint keys while every other decoded
  // dialog field reads identically. A Soroban transaction whose footprint is
  // absent (unprepared — it could never execute anyway) or cannot be rendered
  // in full must therefore fail closed before any dialog opens.
  if (isSoroban) {
    const undisplayableFootprint = findUndisplayableFootprint(
      getSorobanData(innerTx),
    );
    if (undisplayableFootprint === 'missing') {
      throw invalidRequest(
        'This Soroban transaction carries no footprint (Soroban transaction data). Prepare or simulate the transaction before requesting a signature.',
      );
    }
    if (undisplayableFootprint === 'truncated') {
      throw invalidRequest(
        'This transaction touches more ledger entries than can be displayed, or its footprint cannot be decoded in full. Signing is refused.',
      );
    }
  }

  // Soroban transactions get a display-verification simulation (Sui-snap
  // pattern): resource fee, required auth signers, restore requirements.
  // The transaction itself is never modified — we sign the provided XDR.
  //
  // A sequence-0 envelope is excluded: it can never execute on-chain, so
  // there is nothing for a simulation to verify, and its dialog branch does
  // not render a simulation section anyway. Simulating it anyway would spend
  // a global pre-dialog budget slot and an RPC round trip on a result that is
  // then discarded, which a dapp could drive deliberately.
  let simulation: SimulationSummary | null = null;
  if (isSoroban && innerTx.sequence !== '0') {
    // Simulate the operation-bearing envelope (the inner tx for a fee bump).
    const sorobanXdr =
      tx instanceof Transaction ? request.xdr : innerTx.toXDR();
    simulation = await simulateForDisplay(
      network.sorobanRpcUrl,
      sorobanXdr,
      connected,
    );
  }

  // Classic transactions get best-effort safety checks (unfunded
  // destinations, SEP-29 memo requirements, multisig weight). Advisory only.
  // Fee bumps get the destination/existence checks against their inner
  // transaction, but the weight check moves to the fee source: the wallet
  // signs only the outer envelope, so inner-source thresholds are not what
  // its signature is measured against.
  let warnings: string[] = [];
  if (!isSoroban && innerTx.sequence !== '0') {
    warnings = await collectSafetyWarnings(innerTx, network, signerAddress, {
      signerSignsSources: tx instanceof Transaction,
      connected,
    });
  }
  if (!(tx instanceof Transaction)) {
    warnings = [
      ...(await collectFeeSourceWarnings(
        tx.feeSource,
        network,
        signerAddress,
        connected,
      )),
      ...warnings,
    ];
  }

  recordDialogOpened(origin);
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
        // Which host receives the signed envelope when `submit` is set. On
        // PUBLIC the Soroban path is a third-party gateway (SDF operates no
        // public mainnet RPC), and a submission endpoint is trusted with more
        // than display: it can accept an envelope, report its correct hash,
        // and never broadcast it, retaining a valid signed transaction. The
        // user approving a one-click submit must be able to see who that is.
        submitEndpoint: isSoroban ? network.sorobanRpcUrl : network.horizonUrl,
      }),
    },
  });
  if (!approved) {
    throw userRejected();
  }
  // An approved dialog breaks the consecutive-rejection chain.
  clearDialogRejections(origin);

  // An approved signature is also consent to be connected. Best effort: see
  // `recordGrantBestEffort`.
  await recordGrantBestEffort(origin);

  tx.sign(keypair);
  const signedTxXdr = tx.toXDR();
  const warningsField = warnings.length > 0 ? { warnings } : {};

  if (request.submit) {
    // The hash of the exact signed envelope, computed locally. Submission
    // responses are endpoint-controlled input: a hash is accepted only when
    // it matches this value, so a compromised endpoint cannot make the snap
    // report an unrelated transaction as the submitted one.
    const expectedHash = tx.hash().toString('hex');
    const assertSubmittedHash = (returned: string): void => {
      if (returned.toLowerCase() !== expectedHash.toLowerCase()) {
        throw externalServiceError(
          'The submission endpoint returned a transaction hash that does not match the signed transaction. Treat the submission status as unknown.',
        );
      }
    };
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
        assertSubmittedHash(sent.hash);
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
      assertSubmittedHash(txHash);
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
  // Read once, before any pre-dialog lookup, exactly as `signTransaction`
  // does: a standing grant decides which share of the global pre-dialog
  // budget the ledger-height reads below draw on.
  const connected = await isOriginConnected(origin);

  assertNetworkStated(network, request.networkPassphrase);
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
  // Fail closed on truncation too: a rendering limit means part of what
  // would be authorized stays undisclosed in the dialog.
  if (decoded.truncated) {
    throw invalidRequest(
      'This authorization entry is too large or deeply nested to display in full. Signing is refused.',
    );
  }

  // The entry itself names the authorizing account, so it selects the
  // signing account — resolved among owned, revealed accounts only. An
  // explicit `address` option must agree with the entry.
  //
  // The address is asserted before it is used: `resolveSigningKeypair` reads
  // `undefined` as "no selection" and falls back to the active account, so a
  // decode that ever yielded address-credentials without an address would
  // sign an entry naming someone else. Unreachable today, fail-closed here.
  if (!decoded.address) {
    throw invalidRequest(
      'This authorization entry does not name an authorizing account. Signing is refused.',
    );
  }
  if (request.address !== undefined && request.address !== decoded.address) {
    throw invalidRequest(
      'The address option does not match the account named by the authorization entry.',
    );
  }
  // The entry names the account, so the entry itself is the selection: an
  // entry naming any account but the active one needs a grant, exactly like
  // an explicit `address` option.
  await assertAccountSelectionAllowed(origin, decoded.address);
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
  // the ledger cannot be fetched, no expiry can be checked against that cap,
  // so the request fails closed rather than passing through unverified.
  //
  // The height is read from two independent sources and the minimum wins.
  // The default expiry is `latest + N`, and the lifetime cap compares
  // `requested - latest`, so a single source that inflates the height could
  // stretch a "five minute" default authorization arbitrarily while the
  // dialog still says five minutes. On PUBLIC the Soroban RPC is a
  // third-party gateway, so it must not be the only voice; taking the
  // minimum means a lying source can only shorten a lifetime (at worst a
  // spurious "expired" rejection), never extend one.
  //
  // Both reads are pre-dialog network work. They sit behind a connection
  // grant, unlike the `signTransaction` safety lookups: an address-credential
  // entry always names its authorizing account, and naming an account is
  // account selection, which `assertAccountSelectionAllowed` above gates
  // unconditionally. So this path is not part of the cold-callable surface.
  //
  // It claims the same global, origin-independent budget anyway, because that
  // budget bounds total outbound work against shared community infrastructure
  // and not merely the unauthenticated share of it. Leaving it unclaimed would
  // leave the per-origin rate limit as the only bound, and that resets per
  // subdomain (src/rpc/limiter.ts).
  //
  // Unlike the advisory callers, denial here does NOT degrade to a visible
  // caution. The ledger height is not decoration: it is what bounds the
  // signature's lifetime, and this module already refuses to sign when the
  // height cannot be verified. Denial therefore takes the same fail-closed
  // path as an unreachable endpoint.
  let latestLedger: number | null = null;
  const budgeted = takePredialogBudget(connected, 2);
  if (budgeted) {
    const [rpcLedger, horizonLedger] = await Promise.all([
      getLatestLedger(network.sorobanRpcUrl).catch(() => null),
      getHorizonLatestLedger(network.horizonUrl),
    ]);
    const ledgerSources = [rpcLedger, horizonLedger].filter(
      (sequence): sequence is number => sequence !== null,
    );
    latestLedger = ledgerSources.length > 0 ? Math.min(...ledgerSources) : null;
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
    // Same fail-closed outcome either way; the message distinguishes an
    // unreachable endpoint from a budget the caller can simply wait out.
    throw externalServiceError(
      budgeted
        ? 'Could not reach the Stellar RPC to verify the authorization expiry. Try again later.'
        : 'Too many ledger lookups have run recently, so the authorization expiry could not be verified. Try again in a minute.',
    );
  }
  const { validUntil, ledgersRemaining } = bounded;

  recordDialogOpened(origin);
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
  // An approved dialog breaks the consecutive-rejection chain.
  clearDialogRejections(origin);

  await recordGrantBestEffort(origin);

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

  await assertAccountSelectionAllowed(origin, request.address);
  const { keypair, index: accountIndex } = await resolveSigningKeypair(
    request.address,
  );
  const signerAddress = keypair.publicKey();

  recordDialogOpened(origin);
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
  // An approved dialog breaks the consecutive-rejection chain.
  clearDialogRejections(origin);

  await recordGrantBestEffort(origin);

  const payload = hash(
    Buffer.concat([
      Buffer.from(SIGNED_MESSAGE_PREFIX, 'utf8'),
      Buffer.from(request.message, 'utf8'),
    ]),
  );
  const signature = keypair.sign(payload);

  return { signedMessage: signature.toString('base64'), signerAddress };
}
