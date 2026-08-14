import type { OperationRecord, Transaction } from '@stellar/stellar-sdk';

import { getAccountChecks } from './horizon';
import type { NetworkConfig } from '../state/networks';
import { truncate } from '../ui/format';

/** Cap Horizon destination lookups so dialog latency stays bounded. */
const MAX_DESTINATION_CHECKS = 3;

/** Cap Horizon source lookups so dialog latency stays bounded. */
const MAX_SOURCE_CHECKS = 3;

/** Stellar operation threshold levels, in ascending order. */
type ThresholdLevel = 'low' | 'med' | 'high';

const LEVEL_ORDER: Record<ThresholdLevel, number> = { low: 0, med: 1, high: 2 };

const LEVEL_LABEL: Record<ThresholdLevel, string> = {
  low: 'low',
  med: 'medium',
  high: 'high',
};

/**
 * The signature threshold an operation requires from its source account.
 * Only the operation types the snap supports need classification; anything
 * unrecognized is treated as medium (the protocol default for most types).
 *
 * @param operation - The parsed operation.
 * @returns The required threshold level.
 */
function operationThreshold(operation: OperationRecord): ThresholdLevel {
  // Deliberately non-exhaustive: every operation type not named here
  // requires the medium threshold, which the default arm returns.
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (operation.type) {
    case 'accountMerge':
      return 'high';
    case 'setOptions':
      // Signer changes, master-key weight, and threshold changes are
      // high-threshold; other settings (home domain, flags, inflation
      // destination) are medium.
      return operation.signer !== undefined ||
        operation.masterWeight !== undefined ||
        operation.lowThreshold !== undefined ||
        operation.medThreshold !== undefined ||
        operation.highThreshold !== undefined
        ? 'high'
        : 'med';
    default:
      return 'med';
  }
}

/**
 * Collects best-effort safety warnings for a classic transaction before the
 * review dialog: unfunded or memo-requiring destinations (including account
 * merges), unfunded source accounts (per effective operation source, not only
 * the transaction source), and insufficient signature weight measured against
 * the highest threshold the operations actually require. Degrades silently
 * when Horizon is unreachable — warnings are advisory display aids, never
 * blockers — but always says so when a lookup budget forced it to skip
 * accounts, so partial coverage is never mistaken for a clean check.
 *
 * @param tx - The parsed classic transaction (not seq-0; for a fee bump,
 * its inner transaction).
 * @param network - The active network config.
 * @param signerAddress - The wallet's signing address.
 * @param options - Check options.
 * @param options.signerSignsSources - Whether the wallet's signature is what
 * the source accounts' thresholds are measured against. False for a fee
 * bump: the wallet signs only the outer envelope, so inner-source weight
 * warnings would be spurious (existence and memo checks still apply). Use
 * {@link collectFeeSourceWarnings} for the account the wallet does sign for.
 * @returns Advisory warning strings (empty when nothing to flag).
 */
export async function collectSafetyWarnings(
  tx: Transaction,
  network: NetworkConfig,
  signerAddress: string,
  options: { signerSignsSources?: boolean } = {},
): Promise<string[]> {
  const { signerSignsSources = true } = options;
  const warnings: string[] = [];

  // Destinations of value-moving operations (classic G-addresses only).
  // Account merges transfer the source's entire XLM balance, so their
  // destinations carry the same existence and SEP-29 memo risks as payments.
  const valueDestinations = new Set<string>();
  for (const operation of tx.operations) {
    if (
      (operation.type === 'payment' ||
        operation.type === 'pathPaymentStrictSend' ||
        operation.type === 'pathPaymentStrictReceive' ||
        operation.type === 'accountMerge') &&
      typeof operation.destination === 'string' &&
      operation.destination.startsWith('G')
    ) {
      valueDestinations.add(operation.destination);
    }
  }

  const hasMemo = tx.memo.type !== 'none';
  const allDestinations = [...valueDestinations];
  const destinations = allDestinations.slice(0, MAX_DESTINATION_CHECKS);
  if (allDestinations.length > destinations.length) {
    warnings.push(
      `This transaction pays ${allDestinations.length} different destinations; only the first ${destinations.length} were checked for existence and memo requirements. The rest were NOT checked.`,
    );
  }

  // The effective source of every operation, with the highest threshold its
  // operations require. The transaction source is always checked (it pays
  // the fee and provides the sequence number) even when every operation
  // overrides it.
  const requiredBySource = new Map<string, ThresholdLevel>();
  if (tx.source.startsWith('G')) {
    requiredBySource.set(tx.source, 'low');
  }
  for (const operation of tx.operations) {
    const source = operation.source ?? tx.source;
    if (!source.startsWith('G')) {
      continue;
    }
    const level = operationThreshold(operation);
    const known = requiredBySource.get(source);
    if (known === undefined || LEVEL_ORDER[level] > LEVEL_ORDER[known]) {
      requiredBySource.set(source, level);
    }
  }

  const allSources = [...requiredBySource.keys()];
  const sources = allSources.slice(0, MAX_SOURCE_CHECKS);
  if (allSources.length > sources.length) {
    warnings.push(
      `This transaction draws on ${allSources.length} different source accounts; only the first ${sources.length} were checked. The rest were NOT checked.`,
    );
  }

  const [destinationChecks, sourceChecks] = await Promise.all([
    Promise.all(
      destinations.map(async (destination) =>
        getAccountChecks(network.horizonUrl, destination),
      ),
    ),
    Promise.all(
      sources.map(async (source) =>
        getAccountChecks(network.horizonUrl, source),
      ),
    ),
  ]);

  destinations.forEach((destination, index) => {
    const checks = destinationChecks[index];
    if (!checks) {
      return;
    }
    if (!checks.exists) {
      warnings.push(
        `Destination ${truncate(destination)} does not exist on ${network.name}. A payment or merge to it will fail — fund it first or use createAccount.`,
      );
    } else if (checks.memoRequired && !hasMemo) {
      warnings.push(
        `Destination ${truncate(destination)} requires a transaction memo (SEP-29). Sending without one may make funds unrecoverable.`,
      );
    }
  });

  sources.forEach((source, index) => {
    const checks = sourceChecks[index];
    if (!checks) {
      return;
    }
    if (!checks.exists) {
      warnings.push(
        `Source account ${truncate(source)} does not exist on ${network.name} — this transaction will fail if submitted.`,
      );
      return;
    }
    if (!signerSignsSources || !checks.thresholds) {
      return;
    }
    const level = requiredBySource.get(source) ?? 'med';
    const required = Math.max(checks.thresholds[level], 1);
    const ownWeight =
      checks.signers.find((signer) => signer.key === signerAddress)?.weight ??
      0;
    if (ownWeight < required) {
      warnings.push(
        `Your key's weight (${ownWeight}) on account ${truncate(source)} is below the ${LEVEL_LABEL[level]} threshold (${required}) its operations require. The signed transaction will need additional co-signers before submission.`,
      );
    }
  });

  return warnings;
}

/**
 * Collects best-effort safety warnings for a fee-bump envelope's fee source:
 * the account the wallet's signature actually authorizes. Checks existence
 * and the wallet key's weight against the fee source's low threshold (the
 * level a fee-bump signature must meet). Best-effort like
 * {@link collectSafetyWarnings}: degrades silently when Horizon is
 * unreachable, and skips muxed (`M...`) fee sources it cannot look up.
 *
 * @param feeSource - The fee-bump envelope's fee source account.
 * @param network - The active network config.
 * @param signerAddress - The wallet's signing address.
 * @returns Advisory warning strings (empty when nothing to flag).
 */
export async function collectFeeSourceWarnings(
  feeSource: string,
  network: NetworkConfig,
  signerAddress: string,
): Promise<string[]> {
  if (!feeSource.startsWith('G')) {
    return [];
  }
  const checks = await getAccountChecks(network.horizonUrl, feeSource);
  if (!checks) {
    return [];
  }
  if (!checks.exists) {
    return [
      `Fee source ${truncate(feeSource)} does not exist on ${network.name} — this fee bump will fail if submitted.`,
    ];
  }
  if (!checks.thresholds) {
    return [];
  }
  const required = Math.max(checks.thresholds.low, 1);
  const ownWeight =
    checks.signers.find((signer) => signer.key === signerAddress)?.weight ?? 0;
  if (ownWeight < required) {
    return [
      `Your key's weight (${ownWeight}) on the fee source ${truncate(feeSource)} is below the low threshold (${required}) a fee bump requires. The signed fee bump will need additional co-signers before submission.`,
    ];
  }
  return [];
}
