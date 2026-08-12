import type { OperationRecord, Transaction } from '@stellar/stellar-sdk';
import { Address, Asset, hash, scValToNative, xdr } from '@stellar/stellar-sdk';

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

/** Depth and collection-size caps for rendered ScVals (resource bound). */
const MAX_SCVAL_DEPTH = 8;
const MAX_SCVAL_ITEMS = 20;
/** Bytes rendered as hex before an explicit truncation marker. */
const MAX_SCVAL_BYTES = 64;

/**
 * Renders an SCSymbol-ish name: bare when it is a plain identifier, quoted
 * (with control characters escaped) otherwise, so an odd name cannot spoof
 * the display.
 *
 * @param name - The symbol text.
 * @returns The display string.
 */
function formatSymbolName(name: string): string {
  return /^[A-Za-z0-9_]+$/u.test(name) ? name : JSON.stringify(name);
}

/**
 * Stringifies an ScVal in typed notation (`u32(5)`, `sym(transfer)`,
 * `bytes(6a6f…)`) so values of different types can never render
 * identically. Bounded in depth, item count, and byte length; truncation is
 * always marked explicitly. Falls back to the raw base64 XDR when a value
 * cannot be decoded.
 *
 * @param value - The ScVal to render.
 * @param depth - Current nesting depth.
 * @returns A display string.
 */
export function formatScVal(value: xdr.ScVal, depth = 0): string {
  try {
    return formatScValInner(value, depth);
  } catch {
    return value.toXDR('base64');
  }
}

/**
 * Typed per-variant ScVal rendering; throws on malformed values (the caller
 * degrades to raw XDR).
 *
 * @param value - The ScVal to render.
 * @param depth - Current nesting depth.
 * @returns A display string.
 */
function formatScValInner(value: xdr.ScVal, depth: number): string {
  if (depth >= MAX_SCVAL_DEPTH) {
    return '…(too deep)';
  }
  switch (value.switch().name) {
    case 'scvBool':
      return value.b() ? 'true' : 'false';
    case 'scvVoid':
      return 'void';
    case 'scvU32':
      return `u32(${value.u32()})`;
    case 'scvI32':
      return `i32(${value.i32()})`;
    case 'scvU64':
      return `u64(${value.u64().toString()})`;
    case 'scvI64':
      return `i64(${value.i64().toString()})`;
    case 'scvTimepoint':
      return `timepoint(${value.timepoint().toString()})`;
    case 'scvDuration':
      return `duration(${value.duration().toString()})`;
    case 'scvU128':
    case 'scvI128':
    case 'scvU256':
    case 'scvI256': {
      const native = scValToNative(value) as bigint;
      return `${value.switch().name.slice(3).toLowerCase()}(${native.toString()})`;
    }
    case 'scvBytes': {
      const bytes = value.bytes();
      const hexBytes = bytes.subarray(0, MAX_SCVAL_BYTES).toString('hex');
      const suffix =
        bytes.length > MAX_SCVAL_BYTES
          ? ` …+${bytes.length - MAX_SCVAL_BYTES} bytes`
          : '';
      return `bytes(${hexBytes}${suffix})`;
    }
    case 'scvString':
      return `str(${JSON.stringify(value.str().toString())})`;
    case 'scvSymbol':
      return `sym(${formatSymbolName(value.sym().toString())})`;
    case 'scvAddress':
      return Address.fromScVal(value).toString();
    case 'scvVec': {
      const items = value.vec() ?? [];
      const shown = items
        .slice(0, MAX_SCVAL_ITEMS)
        .map((item) => formatScVal(item, depth + 1));
      if (items.length > MAX_SCVAL_ITEMS) {
        shown.push(`…+${items.length - MAX_SCVAL_ITEMS} more`);
      }
      return `[${shown.join(', ')}]`;
    }
    case 'scvMap': {
      const entries = value.map() ?? [];
      const shown = entries
        .slice(0, MAX_SCVAL_ITEMS)
        .map(
          (entry) =>
            `${formatScVal(entry.key(), depth + 1)}: ${formatScVal(
              entry.val(),
              depth + 1,
            )}`,
        );
      if (entries.length > MAX_SCVAL_ITEMS) {
        shown.push(`…+${entries.length - MAX_SCVAL_ITEMS} more`);
      }
      return `{${shown.join(', ')}}`;
    }
    case 'scvContractInstance':
      return 'contract-instance';
    case 'scvLedgerKeyContractInstance':
      return 'ledger-key(contract-instance)';
    case 'scvLedgerKeyNonce':
      return 'ledger-key(nonce)';
    case 'scvError':
      return 'error(see raw XDR)';
    default:
      return `unsupported(${value.switch().name})`;
  }
}

export type DecodedHostFunction = {
  kind: 'invoke' | 'uploadWasm' | 'createContract' | 'unknown';
  contract?: string;
  functionName?: string;
  args: string[];
  /** Display lines for non-invoke host functions (deploy parameters). */
  details?: string[];
};

/**
 * Describes create-contract parameters (deployer, salt, executable, and V2
 * constructor args) so a deployment is reviewable rather than a bare label.
 *
 * @param args - The XDR create-contract args (V1 or V2).
 * @returns Display lines.
 */
function describeCreateContractArgs(
  args: xdr.CreateContractArgs | xdr.CreateContractArgsV2,
): string[] {
  const lines: string[] = [];

  const preimage = args.contractIdPreimage();
  if (preimage.switch().name === 'contractIdPreimageFromAddress') {
    const fromAddress = preimage.fromAddress();
    lines.push(
      `Deployer: ${Address.fromScAddress(fromAddress.address()).toString()}`,
      `Salt: ${fromAddress.salt().toString('hex')}`,
    );
  } else {
    let assetLabel = 'classic asset (see raw XDR)';
    try {
      assetLabel = Asset.fromOperation(preimage.fromAsset()).toString();
    } catch {
      // Keep the generic label; the raw XDR remains the source of truth.
    }
    lines.push(`Source: wrapped classic asset (SAC) ${assetLabel}`);
  }

  const executable = args.executable();
  if (executable.switch().name === 'contractExecutableWasm') {
    lines.push(`Wasm hash: ${executable.wasmHash().toString('hex')}`);
  } else {
    lines.push('Executable: built-in token contract');
  }

  if (args instanceof xdr.CreateContractArgsV2) {
    const ctorArgs = args.constructorArgs();
    if (ctorArgs.length > 0) {
      lines.push(
        `Constructor args: ${ctorArgs
          .map((value) => formatScVal(value))
          .join(', ')}`,
      );
    }
  }

  return lines;
}

/**
 * Decodes an `invokeHostFunction` host function for display. Unknown host
 * function types are reported as `kind: 'unknown'` so the caller can fail
 * closed instead of mislabeling them.
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
        args: invocation.args().map((value) => formatScVal(value)),
      };
    }
    case 'hostFunctionTypeUploadContractWasm': {
      const wasm = hostFunction.wasm();
      return {
        kind: 'uploadWasm',
        args: [],
        details: [
          `Wasm size: ${wasm.length} bytes`,
          `Wasm SHA-256: ${hash(wasm).toString('hex')}`,
        ],
      };
    }
    case 'hostFunctionTypeCreateContract':
      return {
        kind: 'createContract',
        args: [],
        details: describeCreateContractArgs(hostFunction.createContract()),
      };
    case 'hostFunctionTypeCreateContractV2':
      return {
        kind: 'createContract',
        args: [],
        details: describeCreateContractArgs(hostFunction.createContractV2()),
      };
    default:
      return { kind: 'unknown', args: [] };
  }
}

export type DecodedAuthEntry = {
  /** 'sourceAccount' entries ride on the envelope signature. */
  credentialsType: 'sourceAccount' | 'address' | 'unknown';
  address?: string;
  nonce?: string;
  signatureExpirationLedger?: number;
  /** Human-readable invocation tree, root first. */
  invocations: string[];
  /** The entry contains a variant the snap cannot faithfully display. */
  unsupported: boolean;
};

/** Mutable flags threaded through an invocation-tree walk. */
type InvocationFlags = { unsupported: boolean };

/**
 * Renders one authorized invocation as `contract.function(args)` with the
 * full contract address. Create-contract invocations render their deploy
 * parameters; unknown function types are marked and flagged so callers can
 * fail closed.
 *
 * @param invocation - The XDR invocation node.
 * @param flags - Walk flags; `unsupported` is set on unknown variants.
 * @returns A display string.
 */
function describeInvocation(
  invocation: xdr.SorobanAuthorizedInvocation,
  flags: InvocationFlags,
): string {
  const fn = invocation.function();
  switch (fn.switch().name) {
    case 'sorobanAuthorizedFunctionTypeContractFn': {
      const args = fn.contractFn();
      const contract = Address.fromScAddress(args.contractAddress()).toString();
      const rendered = args
        .args()
        .slice(0, MAX_SCVAL_ITEMS)
        .map((value) => formatScVal(value));
      if (args.args().length > MAX_SCVAL_ITEMS) {
        rendered.push(`…+${args.args().length - MAX_SCVAL_ITEMS} more`);
      }
      return `${contract}.${formatSymbolName(
        args.functionName().toString(),
      )}(${rendered.join(', ')})`;
    }
    case 'sorobanAuthorizedFunctionTypeCreateContractHostFn':
      return `create-contract(${describeCreateContractArgs(
        fn.createContractHostFn(),
      ).join('; ')})`;
    case 'sorobanAuthorizedFunctionTypeCreateContractV2HostFn':
      return `create-contract(${describeCreateContractArgs(
        fn.createContractV2HostFn(),
      ).join('; ')})`;
    default:
      flags.unsupported = true;
      return `(unsupported authorization function: ${fn.switch().name})`;
  }
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
 * @param flags - Walk flags; `unsupported` is set on unknown variants.
 * @returns Display strings, root first.
 */
function flattenInvocations(
  invocation: xdr.SorobanAuthorizedInvocation,
  depth = 0,
  budget = { nodes: MAX_INVOCATION_NODES },
  flags: InvocationFlags = { unsupported: false },
): string[] {
  if (depth >= MAX_INVOCATION_DEPTH || budget.nodes <= 0) {
    return ['… (invocation tree truncated — review the raw XDR)'];
  }
  budget.nodes -= 1;
  const prefix = depth > 0 ? `${'· '.repeat(depth)}` : '';
  const lines = [`${prefix}${describeInvocation(invocation, flags)}`];
  for (const sub of invocation.subInvocations()) {
    if (budget.nodes <= 0) {
      lines.push(`${'· '.repeat(depth + 1)}… (truncated)`);
      break;
    }
    lines.push(...flattenInvocations(sub, depth + 1, budget, flags));
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
  const flags: InvocationFlags = { unsupported: false };
  const invocations = flattenInvocations(
    entry.rootInvocation(),
    0,
    { nodes: MAX_INVOCATION_NODES },
    flags,
  );

  if (credentials.switch().name === 'sorobanCredentialsSourceAccount') {
    return {
      credentialsType: 'sourceAccount',
      invocations,
      unsupported: flags.unsupported,
    };
  }

  if (credentials.switch().name !== 'sorobanCredentialsAddress') {
    // A credential variant this snap does not know cannot be reviewed
    // faithfully; callers must fail closed.
    return { credentialsType: 'unknown', invocations, unsupported: true };
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
    unsupported: flags.unsupported,
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
  const lines = entries
    .slice(0, MAX_EMBEDDED_AUTH_ENTRIES)
    .map((entry, index) => {
      try {
        const decoded = decodeAuthEntry(entry);
        let who = 'source-account';
        if (decoded.credentialsType === 'address') {
          who = decoded.address ?? 'address';
        } else if (decoded.credentialsType === 'unknown') {
          who = 'unknown credentials — review the raw XDR';
        }
        return `#${index + 1} [${who}]\n${decoded.invocations.join('\n')}`;
      } catch {
        return `#${index + 1} (undecodable — review the raw XDR)`;
      }
    });
  if (entries.length > MAX_EMBEDDED_AUTH_ENTRIES) {
    lines.push(
      `… ${entries.length - MAX_EMBEDDED_AUTH_ENTRIES} more entries not shown — review the raw XDR`,
    );
  }
  return lines;
}

/** Caps on endpoint-controlled simulation arrays (resource bound). */
const MAX_SIM_RESULTS = 10;
const MAX_SIM_AUTH_PER_RESULT = 20;
const MAX_SIM_AUTH_SIGNERS = 20;

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

  // The response is endpoint-controlled: bound every iterated array so a
  // hostile or compromised RPC cannot force unbounded decoding or an
  // unreviewably large dialog.
  const authSigners: string[] = [];
  const seenSigners = new Set<string>();
  for (const result of (response.results ?? []).slice(0, MAX_SIM_RESULTS)) {
    for (const authXdr of (result.auth ?? []).slice(
      0,
      MAX_SIM_AUTH_PER_RESULT,
    )) {
      try {
        const decoded = decodeAuthEntry(
          xdr.SorobanAuthorizationEntry.fromXDR(authXdr, 'base64'),
        );
        if (
          decoded.credentialsType === 'address' &&
          decoded.address &&
          !seenSigners.has(decoded.address) &&
          authSigners.length < MAX_SIM_AUTH_SIGNERS
        ) {
          seenSigners.add(decoded.address);
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
