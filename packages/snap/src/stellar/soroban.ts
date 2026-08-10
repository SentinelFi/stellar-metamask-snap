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
 * Flattens an invocation tree depth-first, indenting sub-invocations.
 *
 * @param invocation - The root invocation.
 * @param depth - Current depth (indentation).
 * @returns Display strings, root first.
 */
function flattenInvocations(
  invocation: xdr.SorobanAuthorizedInvocation,
  depth = 0,
): string[] {
  const prefix = depth > 0 ? `${'· '.repeat(depth)}` : '';
  return [
    `${prefix}${describeInvocation(invocation)}`,
    ...invocation
      .subInvocations()
      .flatMap((sub) => flattenInvocations(sub, depth + 1)),
  ];
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
