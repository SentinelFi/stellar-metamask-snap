import type { OperationRecord, Transaction } from '@stellar/stellar-sdk/base';

import { getAccountChecks } from './horizon';
import { takePredialogBudget } from '../rpc/limiter';
import type { NetworkConfig } from '../state/networks';
import { truncate } from '../ui/format';

/**
 * The advisory shown when a check could not be performed at all, rather than
 * performed and passed. Absence of a warning must never read as "verified
 * safe", so every path that skips work says so in the same voice as the
 * lookup-budget advisories below.
 */
const SKIPPED_PREFIX = 'Safety checks were skipped:';

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
 * the highest threshold the operations actually require. Warnings are
 * advisory display aids, never blockers, so an unreachable Horizon does not
 * block signing; but every account a lookup did not cover, whether because a
 * budget forced a skip or because Horizon failed, is disclosed as unchecked,
 * so partial coverage is never mistaken for a clean check.
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
 * @param options.connected - Whether the requesting origin holds a standing
 * connection grant. Decides which share of the global pre-dialog budget these
 * lookups draw on, so a cold-callable origin cannot starve a connected site.
 * Defaults to false, the conservative side: an unconnected caller must never
 * reach the reserved share by omission.
 * @returns Advisory warning strings (empty when nothing to flag).
 */
export async function collectSafetyWarnings(
  tx: Transaction,
  network: NetworkConfig,
  signerAddress: string,
  options: { signerSignsSources?: boolean; connected?: boolean } = {},
): Promise<string[]> {
  const { signerSignsSources = true, connected = false } = options;
  const warnings: string[] = [];

  // Destinations of value-moving operations. Account merges transfer the
  // source's entire XLM balance, so their destinations carry the same
  // existence and SEP-29 memo risks as payments.
  //
  // Only classic `G...` addresses can be looked up on Horizon's accounts
  // endpoint. Muxed (`M...`) and any other shape are collected separately
  // rather than dropped: a transaction paying only muxed destinations would
  // otherwise produce zero warnings, which is indistinguishable from one that
  // passed every check. Muxed destinations are common in exchange and
  // custodial flows, which is exactly where the SEP-29 memo warning matters.
  const valueDestinations = new Set<string>();
  const unresolvableAccounts = new Set<string>();
  for (const operation of tx.operations) {
    if (
      operation.type !== 'payment' &&
      operation.type !== 'pathPaymentStrictSend' &&
      operation.type !== 'pathPaymentStrictReceive' &&
      operation.type !== 'accountMerge'
    ) {
      continue;
    }
    const { destination } = operation;
    if (typeof destination !== 'string') {
      continue;
    }
    if (destination.startsWith('G')) {
      valueDestinations.add(destination);
    } else {
      unresolvableAccounts.add(destination);
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
  } else {
    unresolvableAccounts.add(tx.source);
  }
  for (const operation of tx.operations) {
    const source = operation.source ?? tx.source;
    if (!source.startsWith('G')) {
      unresolvableAccounts.add(source);
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

  if (unresolvableAccounts.size > 0) {
    const [first] = [...unresolvableAccounts];
    warnings.push(
      `${SKIPPED_PREFIX} ${unresolvableAccounts.size} muxed or non-standard account address(es) in this transaction (for example ${truncate(
        first ?? '',
      )}) cannot be looked up, so they were NOT checked for existence, memo requirements (SEP-29), or signature weight.`,
    );
  }

  // Claim the global pre-dialog budget before spending it. Denial degrades to
  // a disclosed skip rather than an error: refusing the request outright would
  // let an attacker exhaust the budget to block a legitimate signature, and
  // dropping the warnings silently would let them exhaust it to suppress a
  // real one.
  const lookups = destinations.length + sources.length;
  if (lookups > 0 && !takePredialogBudget(connected, lookups)) {
    warnings.push(
      `${SKIPPED_PREFIX} too many account lookups have run recently, so the accounts in this transaction were NOT checked for existence, memo requirements (SEP-29), or signature weight. Review it carefully, or retry in a minute for the full checks.`,
    );
    return warnings;
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

  // A lookup that returned nothing (Horizon error status, timeout, or a body
  // that failed validation) is a check that did not run, not a check that
  // passed. Count those accounts and say so, in the same voice as the other
  // skips above: without this line a Horizon outage produces zero warnings,
  // which reads exactly like a transaction that was checked and found clean.
  const uncheckedAccounts = [
    ...destinationChecks.filter((checks) => checks === null),
    ...sourceChecks.filter((checks) => checks === null),
  ].length;
  if (uncheckedAccounts > 0) {
    warnings.push(
      `${SKIPPED_PREFIX} Horizon could not be reached or returned an unusable response, so ${uncheckedAccounts} account(s) in this transaction were NOT checked for existence, memo requirements (SEP-29), or signature weight. Review them carefully.`,
    );
  }

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
 * {@link collectSafetyWarnings}: never blocks signing, but discloses a
 * failed Horizon lookup or a muxed (`M...`) fee source it cannot look up as
 * an unchecked account rather than staying silent.
 *
 * @param feeSource - The fee-bump envelope's fee source account.
 * @param network - The active network config.
 * @param signerAddress - The wallet's signing address.
 * @param connected - Whether the requesting origin holds a standing connection
 * grant; decides which share of the global pre-dialog budget this lookup draws
 * on. Defaults to false, matching {@link collectSafetyWarnings}.
 * @returns Advisory warning strings (empty when nothing to flag).
 */
export async function collectFeeSourceWarnings(
  feeSource: string,
  network: NetworkConfig,
  signerAddress: string,
  connected = false,
): Promise<string[]> {
  if (!feeSource.startsWith('G')) {
    // A muxed fee source cannot be looked up. Say so: this is the account the
    // wallet's signature actually authorizes, so silence here is the most
    // misleading silence in the module.
    return [
      `${SKIPPED_PREFIX} the fee source ${truncate(
        feeSource,
      )} is a muxed or non-standard address that cannot be looked up, so it was NOT checked for existence or signature weight.`,
    ];
  }
  if (!takePredialogBudget(connected)) {
    return [
      `${SKIPPED_PREFIX} too many account lookups have run recently, so the fee source ${truncate(
        feeSource,
      )} was NOT checked for existence or signature weight. Review it carefully, or retry in a minute for the full checks.`,
    ];
  }
  const checks = await getAccountChecks(network.horizonUrl, feeSource);
  if (!checks) {
    // Same rule as the per-account checks above: a lookup that failed is a
    // check that did not run, and the account it concerns is the one the
    // wallet's signature authorizes.
    return [
      `${SKIPPED_PREFIX} Horizon could not be reached or returned an unusable response, so the fee source ${truncate(
        feeSource,
      )} was NOT checked for existence or signature weight. Review it carefully.`,
    ];
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
