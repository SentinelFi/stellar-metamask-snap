import type { Transaction } from '@stellar/stellar-sdk';

import { getAccountChecks } from './horizon';
import type { NetworkConfig } from '../state/networks';
import { truncate } from '../ui/format';

/** Cap Horizon lookups so dialog latency stays bounded. */
const MAX_DESTINATION_CHECKS = 3;

/**
 * Collects best-effort safety warnings for a classic transaction before the
 * review dialog: unfunded destinations (payments would fail), SEP-29
 * memo-required destinations, an unfunded source, and insufficient signature
 * weight (multisig accounts). Degrades silently when Horizon is
 * unreachable — warnings are advisory display aids, never blockers.
 *
 * @param tx - The parsed classic transaction (not seq-0, not fee-bump).
 * @param network - The active network config.
 * @param signerAddress - The wallet's signing address.
 * @returns Advisory warning strings (empty when nothing to flag).
 */
export async function collectSafetyWarnings(
  tx: Transaction,
  network: NetworkConfig,
  signerAddress: string,
): Promise<string[]> {
  const warnings: string[] = [];

  // Destinations of value-moving operations (classic G-addresses only).
  const paymentDestinations = new Set<string>();
  for (const operation of tx.operations) {
    if (
      (operation.type === 'payment' ||
        operation.type === 'pathPaymentStrictSend' ||
        operation.type === 'pathPaymentStrictReceive') &&
      operation.destination.startsWith('G')
    ) {
      paymentDestinations.add(operation.destination);
    }
  }

  const hasMemo = tx.memo.type !== 'none';
  const destinations = [...paymentDestinations].slice(
    0,
    MAX_DESTINATION_CHECKS,
  );

  const [sourceChecks, ...destinationChecks] = await Promise.all([
    getAccountChecks(network.horizonUrl, tx.source),
    ...destinations.map(async (destination) =>
      getAccountChecks(network.horizonUrl, destination),
    ),
  ]);

  destinations.forEach((destination, index) => {
    const checks = destinationChecks[index];
    if (!checks) {
      return;
    }
    if (!checks.exists) {
      warnings.push(
        `Destination ${truncate(destination)} does not exist on ${network.name}. A payment to it will fail — fund it first or use createAccount.`,
      );
    } else if (checks.memoRequired && !hasMemo) {
      warnings.push(
        `Destination ${truncate(destination)} requires a transaction memo (SEP-29). Sending without one may make funds unrecoverable.`,
      );
    }
  });

  if (sourceChecks) {
    if (!sourceChecks.exists) {
      warnings.push(
        `Source account ${truncate(tx.source)} does not exist on ${network.name} — this transaction will fail if submitted.`,
      );
    } else if (sourceChecks.thresholds) {
      const ownWeight =
        sourceChecks.signers.find((signer) => signer.key === signerAddress)
          ?.weight ?? 0;
      // Medium covers most operations; a heuristic, not a full per-op
      // threshold analysis.
      const required = Math.max(sourceChecks.thresholds.med, 1);
      if (ownWeight < required) {
        warnings.push(
          `Your key's weight (${ownWeight}) is below the account's medium threshold (${required}). The signed transaction will need additional co-signers before submission.`,
        );
      }
    }
  }

  return warnings;
}
