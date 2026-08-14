import type { OperationRecord, Transaction } from '@stellar/stellar-sdk';
import { Address, Asset, hash, scValToNative, xdr } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { simulateTransaction } from './rpc';
import { takePredialogBudget } from '../rpc/limiter';
import {
  escapeHiddenCharacters,
  sanitizeInlineText,
  truncate,
} from '../ui/format';

/** Soroban operation types (exactly one allowed per transaction). */
const SOROBAN_OPERATION_TYPES = [
  'invokeHostFunction',
  'extendFootprintTtl',
  'restoreFootprint',
];

/**
 * Whether a transaction carries a Soroban operation alongside other
 * operations. The protocol requires a Soroban operation to be the only one
 * in its transaction, so such an envelope can never execute on-chain; it is
 * rejected explicitly rather than being misclassified as classic (which
 * would skip simulation).
 *
 * @param tx - The parsed transaction.
 * @returns True when a Soroban operation appears in a multi-operation tx.
 */
export function hasMisplacedSorobanOperation(tx: Transaction): boolean {
  return (
    tx.operations.length > 1 &&
    tx.operations.some((operation) =>
      SOROBAN_OPERATION_TYPES.includes(operation.type),
    )
  );
}

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
export function formatSymbolName(name: string): string {
  return /^[A-Za-z0-9_]+$/u.test(name)
    ? name
    : escapeHiddenCharacters(JSON.stringify(name));
}

/** Mutable truncation marker threaded through a rendering walk. */
type TruncationFlags = { truncated: boolean };

/**
 * Stringifies an ScVal in typed notation (`u32(5)`, `sym(transfer)`,
 * `bytes(6a6f…)`) so values of different types can never render
 * identically. Bounded in depth, item count, and byte length; truncation is
 * always marked explicitly and reported via `flags` so authorization
 * rendering can fail closed on it. A value that cannot be rendered falls
 * back to its raw XDR in tagged form, `xdr(<base64>)`.
 *
 * @param value - The ScVal to render.
 * @param depth - Current nesting depth.
 * @param flags - Walk flags; `truncated` is set when any limit is reached.
 * @returns A display string.
 */
export function formatScVal(
  value: xdr.ScVal,
  depth = 0,
  flags: TruncationFlags = { truncated: false },
): string {
  try {
    return formatScValInner(value, depth, flags);
  } catch {
    // The value parsed structurally but cannot be rendered. Tag the raw-XDR
    // fallback so it can never imitate a typed rendering: bare base64 is
    // attacker-influenced text whose alphabet covers strkey addresses, so an
    // untagged fallback could be crafted to resemble a G.../C... address.
    // Report it like a truncation so authorization contexts fail closed.
    flags.truncated = true;
    return `xdr(${value.toXDR('base64')})`;
  }
}

/**
 * Typed per-variant ScVal rendering; throws on malformed values (the caller
 * degrades to raw XDR).
 *
 * @param value - The ScVal to render.
 * @param depth - Current nesting depth.
 * @param flags - Walk flags; `truncated` is set when any limit is reached.
 * @returns A display string.
 */
function formatScValInner(
  value: xdr.ScVal,
  depth: number,
  flags: TruncationFlags,
): string {
  if (depth >= MAX_SCVAL_DEPTH) {
    flags.truncated = true;
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
      let suffix = '';
      if (bytes.length > MAX_SCVAL_BYTES) {
        flags.truncated = true;
        suffix = ` …+${bytes.length - MAX_SCVAL_BYTES} bytes`;
      }
      return `bytes(${hexBytes}${suffix})`;
    }
    case 'scvString':
      // JSON.stringify escapes control characters but leaves format
      // characters (bidi overrides, zero-width marks) raw; escape those too
      // so a hostile argument cannot reorder or hide dialog text.
      return `str(${escapeHiddenCharacters(JSON.stringify(value.str().toString()))})`;
    case 'scvSymbol':
      return `sym(${formatSymbolName(value.sym().toString())})`;
    case 'scvAddress':
      return Address.fromScVal(value).toString();
    case 'scvVec': {
      const items = value.vec() ?? [];
      const shown = items
        .slice(0, MAX_SCVAL_ITEMS)
        .map((item) => formatScVal(item, depth + 1, flags));
      if (items.length > MAX_SCVAL_ITEMS) {
        flags.truncated = true;
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
            `${formatScVal(entry.key(), depth + 1, flags)}: ${formatScVal(
              entry.val(),
              depth + 1,
              flags,
            )}`,
        );
      if (entries.length > MAX_SCVAL_ITEMS) {
        flags.truncated = true;
        shown.push(`…+${entries.length - MAX_SCVAL_ITEMS} more`);
      }
      return `{${shown.join(', ')}}`;
    }
    case 'scvContractInstance': {
      const instance = value.instance();
      const executable = instance.executable();
      const executableText =
        executable.switch().name === 'contractExecutableWasm'
          ? `wasm(${executable.wasmHash().toString('hex')})`
          : 'built-in-token';
      const storage = instance.storage() ?? [];
      const shown = storage
        .slice(0, MAX_SCVAL_ITEMS)
        .map(
          (entry) =>
            `${formatScVal(entry.key(), depth + 1, flags)}: ${formatScVal(
              entry.val(),
              depth + 1,
              flags,
            )}`,
        );
      if (storage.length > MAX_SCVAL_ITEMS) {
        flags.truncated = true;
        shown.push(`…+${storage.length - MAX_SCVAL_ITEMS} more`);
      }
      const storageText =
        shown.length > 0 ? `, storage: {${shown.join(', ')}}` : '';
      return `contract-instance(${executableText}${storageText})`;
    }
    // A void arm: the label carries the variant's entire content.
    case 'scvLedgerKeyContractInstance':
      return 'ledger-key(contract-instance)';
    case 'scvLedgerKeyNonce':
      return `ledger-key(nonce(${value.nonceKey().nonce().toString()}))`;
    case 'scvError': {
      const error = value.error();
      const variant = error.switch().name;
      // Only the contract arm carries a numeric code; every other arm
      // carries an ScErrorCode enum value.
      const detail =
        variant === 'sceContract'
          ? error.contractCode().toString()
          : error.code().name;
      return `error(${variant}, ${detail})`;
    }
    default:
      // An unknown future variant cannot be rendered faithfully; flag it so
      // signing paths fail closed rather than approving an opaque label.
      flags.truncated = true;
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
  /**
   * A rendering limit was reached while decoding, so the display would not
   * disclose every argument in full. Signing paths must fail closed on this.
   */
  truncated: boolean;
};

/**
 * Describes create-contract parameters (deployer, salt, executable, and V2
 * constructor args) so a deployment is reviewable rather than a bare label.
 *
 * @param args - The XDR create-contract args (V1 or V2).
 * @param flags - Walk flags; `truncated` is set when a rendering limit is
 * reached.
 * @returns Display lines.
 */
function describeCreateContractArgs(
  args: xdr.CreateContractArgs | xdr.CreateContractArgsV2,
  flags: TruncationFlags = { truncated: false },
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
          .map((value) => formatScVal(value, 0, flags))
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
  const flags: TruncationFlags = { truncated: false };
  switch (hostFunction.switch().name) {
    case 'hostFunctionTypeInvokeContract': {
      const invocation = hostFunction.invokeContract();
      const rawArgs = invocation.args();
      const args = rawArgs
        .slice(0, MAX_SCVAL_ITEMS)
        .map((value) => formatScVal(value, 0, flags));
      if (rawArgs.length > MAX_SCVAL_ITEMS) {
        flags.truncated = true;
        args.push(`…+${rawArgs.length - MAX_SCVAL_ITEMS} more`);
      }
      return {
        kind: 'invoke',
        contract: Address.fromScAddress(
          invocation.contractAddress(),
        ).toString(),
        functionName: invocation.functionName().toString(),
        args,
        truncated: flags.truncated,
      };
    }
    case 'hostFunctionTypeUploadContractWasm': {
      const wasm = hostFunction.wasm();
      // The SHA-256 is a cryptographic commitment to the full wasm blob, so
      // this display is faithful without rendering the bytes.
      return {
        kind: 'uploadWasm',
        args: [],
        details: [
          `Wasm size: ${wasm.length} bytes`,
          `Wasm SHA-256: ${hash(wasm).toString('hex')}`,
        ],
        truncated: false,
      };
    }
    case 'hostFunctionTypeCreateContract':
      return {
        kind: 'createContract',
        args: [],
        details: describeCreateContractArgs(
          hostFunction.createContract(),
          flags,
        ),
        truncated: flags.truncated,
      };
    case 'hostFunctionTypeCreateContractV2':
      return {
        kind: 'createContract',
        args: [],
        details: describeCreateContractArgs(
          hostFunction.createContractV2(),
          flags,
        ),
        truncated: flags.truncated,
      };
    default:
      return { kind: 'unknown', args: [], truncated: true };
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
  /**
   * A rendering limit (depth, item count, or byte length) was reached, so
   * the display would not disclose everything being authorized. Signing
   * paths must fail closed on this.
   */
  truncated: boolean;
};

/** Mutable flags threaded through an invocation-tree walk. */
type InvocationFlags = TruncationFlags & { unsupported: boolean };

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
        .map((value) => formatScVal(value, 0, flags));
      if (args.args().length > MAX_SCVAL_ITEMS) {
        flags.truncated = true;
        rendered.push(`…+${args.args().length - MAX_SCVAL_ITEMS} more`);
      }
      return `${contract}.${formatSymbolName(
        args.functionName().toString(),
      )}(${rendered.join(', ')})`;
    }
    case 'sorobanAuthorizedFunctionTypeCreateContractHostFn':
      return `create-contract(${describeCreateContractArgs(
        fn.createContractHostFn(),
        flags,
      ).join('; ')})`;
    case 'sorobanAuthorizedFunctionTypeCreateContractV2HostFn':
      return `create-contract(${describeCreateContractArgs(
        fn.createContractV2HostFn(),
        flags,
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
  flags: InvocationFlags = { unsupported: false, truncated: false },
): string[] {
  if (depth >= MAX_INVOCATION_DEPTH || budget.nodes <= 0) {
    flags.truncated = true;
    return ['… (invocation tree truncated — review the raw XDR)'];
  }
  budget.nodes -= 1;
  const prefix = depth > 0 ? `${'· '.repeat(depth)}` : '';
  const lines = [`${prefix}${describeInvocation(invocation, flags)}`];
  for (const sub of invocation.subInvocations()) {
    if (budget.nodes <= 0) {
      flags.truncated = true;
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
  const flags: InvocationFlags = { unsupported: false, truncated: false };
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
      truncated: flags.truncated,
    };
  }

  if (credentials.switch().name !== 'sorobanCredentialsAddress') {
    // A credential variant this snap does not know cannot be reviewed
    // faithfully; callers must fail closed.
    return {
      credentialsType: 'unknown',
      invocations,
      unsupported: true,
      truncated: flags.truncated,
    };
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
    truncated: flags.truncated,
  };
}

/** Cap on embedded auth entries rendered inline (rest are in the raw XDR). */
export const MAX_EMBEDDED_AUTH_ENTRIES = 20;

/**
 * Scans embedded authorization entries for anything the snap cannot display
 * faithfully. An embedded source-account entry is authorized by the very
 * envelope signature being requested, so `signTransaction` must fail closed
 * on these, exactly as `signAuthEntry` does for standalone entries.
 *
 * @param entries - The operation's authorization entries.
 * @returns `'undecodable'` when an entry cannot be decoded, `'unsupported'`
 * when one contains an unknown credential or function variant, `'truncated'`
 * when a rendering limit (entry count, depth, item count, or byte length)
 * would leave part of what is authorized undisclosed, or null when every
 * entry is displayable in full.
 */
export function findUndisplayableAuthEntry(
  entries: xdr.SorobanAuthorizationEntry[],
): 'undecodable' | 'unsupported' | 'truncated' | null {
  // More entries than the dialog renders inline means part of what the
  // signature authorizes would be undisclosed: fail closed.
  if (entries.length > MAX_EMBEDDED_AUTH_ENTRIES) {
    return 'truncated';
  }
  for (const entry of entries) {
    let decoded: DecodedAuthEntry;
    try {
      decoded = decodeAuthEntry(entry);
    } catch {
      return 'undecodable';
    }
    if (decoded.credentialsType === 'unknown' || decoded.unsupported) {
      return 'unsupported';
    }
    if (decoded.truncated) {
      return 'truncated';
    }
  }
  return null;
}

/** Default auth-entry lifetime when the dapp leaves it unset (~5 min @ 5s). */
export const DEFAULT_AUTH_TTL_LEDGERS = 60;

/** Cap on a dapp-supplied auth-entry lifetime (~24h @ 5s/ledger). */
export const MAX_AUTH_TTL_LEDGERS = 17_280;

export type AuthExpiryResult =
  | { ok: true; validUntil: number; ledgersRemaining: number }
  | { ok: false; reason: 'expired' | 'tooLong' | 'noLedger' };

/**
 * Bounds a Soroban auth-entry signature lifetime against the current ledger
 * A dapp-supplied expiry must be in the future and within
 * {@link MAX_AUTH_TTL_LEDGERS}; an unset (0) expiry defaults to
 * {@link DEFAULT_AUTH_TTL_LEDGERS} ahead. When the current ledger is unknown
 * (RPC unreachable) no expiry can be verified against the maximum lifetime,
 * so every request fails closed rather than passing through unverified.
 *
 * @param requestedLedger - The dapp's `signatureExpirationLedger` (0 = unset).
 * @param latestLedger - The current ledger, or null when it could not be read.
 * @returns The bounded result, or a rejection reason.
 */
export function boundAuthExpiration(
  requestedLedger: number,
  latestLedger: number | null,
): AuthExpiryResult {
  if (latestLedger === null) {
    return { ok: false, reason: 'noLedger' };
  }
  if (requestedLedger === 0) {
    return {
      ok: true,
      validUntil: latestLedger + DEFAULT_AUTH_TTL_LEDGERS,
      ledgersRemaining: DEFAULT_AUTH_TTL_LEDGERS,
    };
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
        // The nonce and expiry are signed fields that bound replay and
        // lifetime. The decoder already has them, so omitting them from the
        // summary would hide part of what the envelope signature authorizes.
        const meta =
          decoded.credentialsType === 'address'
            ? `\nnonce: ${decoded.nonce ?? '0'}, valid until ledger: ${
                decoded.signatureExpirationLedger ?? 0
              }`
            : '';
        return `#${index + 1} [${who}]${meta}\n${decoded.invocations.join(
          '\n',
        )}`;
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

/** Footprint keys rendered before the summary is marked incomplete. */
export const MAX_FOOTPRINT_KEYS = 20;

/**
 * Extracts a transaction's Soroban data, when it carries any.
 *
 * @param tx - The operation-bearing transaction.
 * @returns The Soroban transaction data, or null for a classic transaction.
 */
export function getSorobanData(
  tx: Transaction,
): xdr.SorobanTransactionData | null {
  try {
    return tx.toEnvelope().v1().tx().ext().sorobanData() ?? null;
  } catch {
    return null;
  }
}

/**
 * Renders a trustline asset from a footprint trustline key. The asset is
 * half of the trustline's identity: `trustline of G…` alone cannot tell two
 * trustlines of the same account apart.
 *
 * @param asset - The XDR trustline asset.
 * @param flags - Walk flags; `truncated` is set when the variant is unknown.
 * @returns A display string identifying the asset.
 */
function describeTrustLineAsset(
  asset: xdr.TrustLineAsset,
  flags: TruncationFlags,
): string {
  switch (asset.switch().name) {
    case 'assetTypeNative':
      return 'XLM (native)';
    case 'assetTypeCreditAlphanum4':
    case 'assetTypeCreditAlphanum12': {
      try {
        const parsed = Asset.fromOperation(
          asset.switch().name === 'assetTypeCreditAlphanum4'
            ? xdr.Asset.assetTypeCreditAlphanum4(asset.alphaNum4())
            : xdr.Asset.assetTypeCreditAlphanum12(asset.alphaNum12()),
        );
        return `${parsed.getCode()}:${parsed.getIssuer()}`;
      } catch {
        flags.truncated = true;
        return 'asset (undecodable — review the raw XDR)';
      }
    }
    case 'assetTypePoolShare':
      return `pool ${Buffer.from(
        asset.liquidityPoolId() as unknown as Uint8Array,
      ).toString('hex')}`;
    default:
      // An unknown future variant cannot be identified faithfully; flag it
      // so the footprint is reported incomplete rather than mislabelled.
      flags.truncated = true;
      return `asset (${asset.switch().name} — review the raw XDR)`;
  }
}

/**
 * Describes one ledger key from a Soroban footprint.
 *
 * @param key - The ledger key.
 * @param flags - Walk flags; `truncated` is set when any part of the key
 * cannot be rendered in full (ScVal limits, unknown variants).
 * @returns A display string identifying what the key addresses.
 */
function describeLedgerKey(key: xdr.LedgerKey, flags: TruncationFlags): string {
  // Deliberately non-exhaustive: only the key types a Soroban footprint can
  // actually contain are named; anything else is reported as incomplete
  // rather than being mislabelled.
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (key.switch().name) {
    case 'contractData': {
      const data = key.contractData();
      // The flags thread through: a contract-data key too large or deep to
      // render in full marks the whole footprint summary incomplete.
      return `contract data ${Address.fromScAddress(
        data.contract(),
      ).toString()} key=${formatScVal(data.key(), 0, flags)} (${data.durability().name})`;
    }
    case 'contractCode':
      return `contract code ${key.contractCode().hash().toString('hex')}`;
    case 'account':
      return `account ${Address.account(
        key.account().accountId().ed25519(),
      ).toString()}`;
    case 'trustline':
      return `trustline of ${Address.account(
        key.trustLine().accountId().ed25519(),
      ).toString()} asset=${describeTrustLineAsset(
        key.trustLine().asset(),
        flags,
      )}`;
    case 'ttl':
      return `ttl ${key.ttl().keyHash().toString('hex')}`;
    default:
      // An unknown key variant means part of the signed state-access scope
      // cannot be shown; mark the summary incomplete so signing fails closed.
      flags.truncated = true;
      return `${key.switch().name} (review the raw XDR)`;
  }
}

/** A rendered Soroban footprint and its resource commitment. */
export type FootprintSummary = {
  lines: string[];
  /** A key or resource value could not be rendered in full. */
  truncated: boolean;
};

/**
 * Summarizes the Soroban transaction footprint: which ledger entries the
 * transaction may read and write, and what resources it commits to.
 *
 * The footprint is a signed field that bounds the transaction's entire
 * state access. Rendering only "extends contract data" or "restores archived
 * data" tells the user nothing about which data, so the scope they approve is
 * not the scope they can see.
 *
 * @param sorobanData - The transaction's Soroban data, when present.
 * @returns The summary, or null when the transaction carries no footprint.
 */
export function summarizeFootprint(
  sorobanData: xdr.SorobanTransactionData | null | undefined,
): FootprintSummary | null {
  if (!sorobanData) {
    return null;
  }

  const lines: string[] = [];
  const flags: TruncationFlags = { truncated: false };

  try {
    const resources = sorobanData.resources();
    const footprint = resources.footprint();

    for (const [label, keys] of [
      ['Read-only', footprint.readOnly()],
      ['Read-write', footprint.readWrite()],
    ] as const) {
      if (keys.length === 0) {
        continue;
      }
      lines.push(`${label} (${keys.length}):`);
      for (const key of keys.slice(0, MAX_FOOTPRINT_KEYS)) {
        lines.push(`  ${describeLedgerKey(key, flags)}`);
      }
      if (keys.length > MAX_FOOTPRINT_KEYS) {
        flags.truncated = true;
        lines.push(`  …+${keys.length - MAX_FOOTPRINT_KEYS} more`);
      }
    }

    lines.push(
      `Instructions: ${resources.instructions()}`,
      `Disk read bytes: ${resources.diskReadBytes()}`,
      `Write bytes: ${resources.writeBytes()}`,
      `Resource fee: ${sorobanData.resourceFee().toString()} stroops`,
    );
  } catch {
    // A footprint this decoder cannot walk must be reported as incomplete
    // rather than shown as an empty scope.
    return {
      lines: ['Footprint could not be decoded — review the raw XDR'],
      truncated: true,
    };
  }

  return lines.length > 0 ? { lines, truncated: flags.truncated } : null;
}

/**
 * Pre-dialog gate for Soroban signing: the footprint bounds the signed
 * state-access scope, so a Soroban transaction whose footprint is absent or
 * cannot be rendered in full must not reach the review dialog. Two
 * transactions may then differ only in footprint keys while presenting the
 * same decoded confirmation — a confirmation-integrity collision.
 *
 * @param sorobanData - The transaction's Soroban data, when present.
 * @returns `'missing'` when the transaction carries no Soroban data,
 * `'truncated'` when part of the footprint cannot be shown in full, or null
 * when the whole footprint is displayable.
 */
export function findUndisplayableFootprint(
  sorobanData: xdr.SorobanTransactionData | null | undefined,
): 'missing' | 'truncated' | null {
  const summary = summarizeFootprint(sorobanData);
  if (!summary) {
    return 'missing';
  }
  return summary.truncated ? 'truncated' : null;
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
  // This simulation runs before any dialog exists and is reachable without a
  // connection grant, so it shares the global pre-dialog budget with the
  // Horizon safety lookups. Denial renders the existing "Simulation
  // unavailable" banner, which already tells the user the call could not be
  // verified: a visible caution, not a silent omission.
  if (!takePredialogBudget()) {
    return {
      ok: false,
      error:
        'Too many simulations have run recently. Retry in a minute to verify this call.',
    };
  }

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
    // Endpoint-controlled text: strip control/bidi characters before the
    // message can reach a dialog, then bound its length.
    return {
      ok: false,
      error: truncate(sanitizeInlineText(response.error), 120),
    };
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
