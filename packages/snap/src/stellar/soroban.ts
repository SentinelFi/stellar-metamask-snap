import type { OperationRecord, Transaction } from '@stellar/stellar-sdk';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';

import { simulateTransaction } from './rpc';
import { truncate } from '../ui/format';

/** Soroban operation types (exactly one allowed per transaction). */
const SOROBAN_OPERATION_TYPES = [
  'invokeHostFunction',
  'extendFootprintTtl',
  'restoreFootprint',
];

/**
 * Returns the transaction's Soroban operation, if it is a Soroban
 * transaction.
 *
 * @param tx - The parsed transaction.
 * @returns The Soroban operation record, or null for classic transactions.
 */
export function getSorobanOperation(tx: Transaction): OperationRecord | null {
  const [operation] = tx.operations;
  if (
    tx.operations.length === 1 &&
    operation &&
    SOROBAN_OPERATION_TYPES.includes(operation.type)
  ) {
    return operation;
  }
  return null;
}

/**
 * Stringifies a decoded ScVal, tolerating BigInt and decode failures.
 *
 * @param value - The ScVal to render.
 * @returns A display string.
 */
export function formatScVal(value: xdr.ScVal): string {
  try {
    const native: unknown = scValToNative(value);
    return JSON.stringify(native, (_key, entry: unknown) =>
      typeof entry === 'bigint' ? entry.toString() : entry,
    );
  } catch {
    return value.toXDR('base64');
  }
}

export type DecodedHostFunction = {
  kind: 'invoke' | 'uploadWasm' | 'createContract';
  contract?: string;
  functionName?: string;
  args: string[];
};

/**
 * Decodes an `invokeHostFunction` host function for display.
 *
 * @param hostFunction - The XDR host function.
 * @returns The decoded description.
 */
export function decodeHostFunction(
  hostFunction: xdr.HostFunction,
): DecodedHostFunction {
  switch (hostFunction.switch().name) {
    case 'hostFunctionTypeInvokeContract': {
      const invocation = hostFunction.invokeContract();
      return {
        kind: 'invoke',
        contract: Address.fromScAddress(
          invocation.contractAddress(),
        ).toString(),
        functionName: invocation.functionName().toString(),
        args: invocation.args().map(formatScVal),
      };
    }
    case 'hostFunctionTypeUploadContractWasm':
      return { kind: 'uploadWasm', args: [] };
    case 'hostFunctionTypeCreateContract':
    case 'hostFunctionTypeCreateContractV2':
    default:
      return { kind: 'createContract', args: [] };
  }
}

export type DecodedAuthEntry = {
  /** 'sourceAccount' entries ride on the envelope signature. */
  credentialsType: 'sourceAccount' | 'address';
  address?: string;
  nonce?: string;
  signatureExpirationLedger?: number;
  /** Human-readable invocation tree, root first. */
  invocations: string[];
};

/**
 * Renders one authorized invocation as `contract.function(args)`.
 *
 * @param invocation - The XDR invocation node.
 * @returns A display string.
 */
function describeInvocation(
  invocation: xdr.SorobanAuthorizedInvocation,
): string {
  const fn = invocation.function();
  if (fn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
    const args = fn.contractFn();
    const contract = Address.fromScAddress(args.contractAddress()).toString();
    return `${truncate(contract, 8)}.${args.functionName().toString()}(${args
      .args()
      .map(formatScVal)
      .join(', ')})`;
  }
  return 'create contract';
}

/**
 * Depth/node caps so a hostile deeply-nested auth tree cannot exhaust the
 * snap or produce an unreviewably large dialog (defense against resource
 * exhaustion; the raw XDR remains available for full inspection).
 */
export const MAX_INVOCATION_DEPTH = 12;
export const MAX_INVOCATION_NODES = 100;

/**
 * Flattens an invocation tree depth-first, indenting sub-invocations. Bounded
 * by depth and total node count; a truncation marker is emitted when either
 * limit is hit rather than recursing without limit.
 *
 * @param invocation - The root invocation.
 * @param depth - Current depth (indentation).
 * @param budget - Mutable remaining-node counter, shared across the walk.
 * @returns Display strings, root first.
 */
function flattenInvocations(
  invocation: xdr.SorobanAuthorizedInvocation,
  depth = 0,
  budget = { nodes: MAX_INVOCATION_NODES },
): string[] {
  if (depth >= MAX_INVOCATION_DEPTH || budget.nodes <= 0) {
    return ['… (invocation tree truncated — review the raw XDR)'];
  }
  budget.nodes -= 1;
  const prefix = depth > 0 ? `${'· '.repeat(depth)}` : '';
  const lines = [`${prefix}${describeInvocation(invocation)}`];
  for (const sub of invocation.subInvocations()) {
    if (budget.nodes <= 0) {
      lines.push(`${'· '.repeat(depth + 1)}… (truncated)`);
      break;
    }
    lines.push(...flattenInvocations(sub, depth + 1, budget));
  }
  return lines;
}

/**
 * Decodes a Soroban authorization entry for display.
 *
 * @param entry - The XDR authorization entry.
 * @returns The decoded description.
 */
export function decodeAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
): DecodedAuthEntry {
  const credentials = entry.credentials();
  const invocations = flattenInvocations(entry.rootInvocation());

  if (credentials.switch().name === 'sorobanCredentialsSourceAccount') {
    return { credentialsType: 'sourceAccount', invocations };
  }

  const address = credentials.address();
  let nonce: string;
  try {
    nonce = address.nonce().toBigInt().toString();
  } catch {
    nonce = String(address.nonce());
  }
  return {
    credentialsType: 'address',
    address: Address.fromScAddress(address.address()).toString(),
    nonce,
    signatureExpirationLedger: address.signatureExpirationLedger(),
    invocations,
  };
}

/** Cap on embedded auth entries rendered inline (rest are in the raw XDR). */
export const MAX_EMBEDDED_AUTH_ENTRIES = 20;

/** Default auth-entry lifetime when the dapp leaves it unset (~5 min @ 5s). */
export const DEFAULT_AUTH_TTL_LEDGERS = 60;

/** Cap on a dapp-supplied auth-entry lifetime (~24h @ 5s/ledger). */
export const MAX_AUTH_TTL_LEDGERS = 17_280;

export type AuthExpiryResult =
  | { ok: true; validUntil: number; ledgersRemaining: number | null }
  | { ok: false; reason: 'expired' | 'tooLong' | 'noLedger' };

/**
 * Bounds a Soroban auth-entry signature lifetime against the current ledger
 * A dapp-supplied expiry must be in the future and within
 * {@link MAX_AUTH_TTL_LEDGERS}; an unset (0) expiry defaults to
 * {@link DEFAULT_AUTH_TTL_LEDGERS} ahead. When the current ledger is unknown
 * (RPC unreachable) a nonzero expiry is passed through unverified, but an
 * unset expiry cannot be resolved and fails.
 *
 * @param requestedLedger - The dapp's `signatureExpirationLedger` (0 = unset).
 * @param latestLedger - The current ledger, or null when it could not be read.
 * @returns The bounded result, or a rejection reason.
 */
export function boundAuthExpiration(
  requestedLedger: number,
  latestLedger: number | null,
): AuthExpiryResult {
  if (requestedLedger === 0) {
    if (latestLedger === null) {
      return { ok: false, reason: 'noLedger' };
    }
    return {
      ok: true,
      validUntil: latestLedger + DEFAULT_AUTH_TTL_LEDGERS,
      ledgersRemaining: DEFAULT_AUTH_TTL_LEDGERS,
    };
  }
  if (latestLedger === null) {
    return { ok: true, validUntil: requestedLedger, ledgersRemaining: null };
  }
  if (requestedLedger <= latestLedger) {
    return { ok: false, reason: 'expired' };
  }
  if (requestedLedger - latestLedger > MAX_AUTH_TTL_LEDGERS) {
    return { ok: false, reason: 'tooLong' };
  }
  return {
    ok: true,
    validUntil: requestedLedger,
    ledgersRemaining: requestedLedger - latestLedger,
  };
}

/**
 * Summarizes the authorization entries embedded in an `invokeHostFunction`
 * operation for inline display: each entry's credential (authorizing account
 * or source-account) and its invocation tree, so the review shows *what* is
 * authorized rather than only a count. Bounded; undecodable entries
 * are flagged rather than dropped.
 *
 * @param entries - The operation's authorization entries.
 * @returns Display lines, one block per entry.
 */
export function summarizeAuthEntries(
  entries: xdr.SorobanAuthorizationEntry[],
): string[] {
  return entries.slice(0, MAX_EMBEDDED_AUTH_ENTRIES).map((entry, index) => {
    try {
      const decoded = decodeAuthEntry(entry);
      let who = 'source-account';
      if (decoded.credentialsType === 'address') {
        who = decoded.address ? truncate(decoded.address, 6) : 'address';
      }
      return `#${index + 1} [${who}]\n${decoded.invocations.join('\n')}`;
    } catch {
      return `#${index + 1} (undecodable — review the raw XDR)`;
    }
  });
}

export type SimulationSummary =
  | {
    ok: true;
    /** Estimated resource fee in stroops. */
    minResourceFee: string;
    /** Addresses that must sign address-credential auth entries. */
    authSigners: string[];
    /** Archived ledger entries must be restored before submission. */
    restoreRequired: boolean;
    latestLedger?: number;
  }
  | { ok: false; error: string };

/**
 * Runs a display-verification simulation. Never throws — the dialog renders
 * the failure so the user can still review the raw transaction. The
 * transaction being signed is never modified by the result.
 *
 * @param rpcUrl - The Soroban RPC endpoint for the active network.
 * @param transactionXdr - The transaction envelope XDR.
 * @returns A summary for the review dialog.
 */
export async function simulateForDisplay(
  rpcUrl: string,
  transactionXdr: string,
): Promise<SimulationSummary> {
  let response;
  try {
    response = await simulateTransaction(rpcUrl, transactionXdr);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Simulation failed.',
    };
  }

  if (response.error) {
    return { ok: false, error: truncate(response.error, 120) };
  }

  const authSigners: string[] = [];
  for (const result of response.results ?? []) {
    for (const authXdr of result.auth ?? []) {
      try {
        const decoded = decodeAuthEntry(
          xdr.SorobanAuthorizationEntry.fromXDR(authXdr, 'base64'),
        );
        if (decoded.credentialsType === 'address' && decoded.address) {
          authSigners.push(decoded.address);
        }
      } catch {
        // Undecodable entries are skipped here; they remain visible to the
        // user via the raw XDR shown in the review dialog.
        continue;
      }
    }
  }

  return {
    ok: true,
    minResourceFee: response.minResourceFee ?? '0',
    authSigners,
    restoreRequired: Boolean(response.restorePreamble),
    ...(response.latestLedger === undefined
      ? {}
      : { latestLedger: response.latestLedger }),
  };
}
