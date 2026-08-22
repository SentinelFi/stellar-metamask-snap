import {
  Account,
  Address,
  Operation,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk/base';
import { Buffer } from 'buffer';

import { simulateTransaction } from './rpc';
import type { NetworkConfig } from '../state/networks';

/**
 * A throwaway source account for read-only simulations: the all-zeros
 * ed25519 account, computed (not hardcoded) so it is self-evidently not a
 * secret. Read-only simulation does not require it to exist on-ledger.
 */
export const SIMULATION_SOURCE = StrKey.encodeEd25519PublicKey(
  Buffer.alloc(32, 0),
);

/** Bound the read chain so a slow/broken RPC cannot hang the caller. */
const READ_TIMEOUT_MS = 8000;

/**
 * Simulates a read-only contract call and returns the decoded return value.
 * Never submits — the transaction is built only to be simulated.
 *
 * @param network - The active network config.
 * @param contractId - The token (SAC/SEP-41) contract address.
 * @param method - The contract function to call.
 * @param args - ScVal arguments.
 * @returns The native-decoded return value, or null on any failure.
 */
async function readContract(
  network: NetworkConfig,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  try {
    const source = new Account(SIMULATION_SOURCE, '0');
    const tx = new TransactionBuilder(source, {
      fee: '100',
      networkPassphrase: network.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: method,
          args,
        }),
      )
      .setTimeout(0)
      .build();

    // The timeout rides the RPC call's own AbortController, so a slow
    // simulation is aborted (not orphaned) and a fast one leaves no timer.
    const response = await simulateTransaction(
      network.sorobanRpcUrl,
      tx.toXDR(),
      READ_TIMEOUT_MS,
    );

    const resultXdr = response.results?.[0]?.xdr;
    if (response.error || !resultXdr) {
      return null;
    }
    return scValToNative(xdr.ScVal.fromXDR(resultXdr, 'base64'));
  } catch {
    return null;
  }
}

export type TokenMetadata = { symbol: string; decimals: number };

/**
 * Upper bound for token decimals (i128 fits 38 digits). Larger values are
 * hostile: `10n ** BigInt(decimals)` grows without bound.
 */
export const MAX_TOKEN_DECIMALS = 38;

/**
 * Symbols must be short and drawn from an alphabet that cannot carry markup
 * or spoofing characters: letters, digits, dot, underscore, and hyphen. Every
 * real SEP-41 symbol fits; what the wider printable-ASCII range would have
 * admitted is punctuation such as `*`, `_` pairs, and backticks, which a
 * markdown-aware renderer could read as emphasis, and brackets and slashes
 * that let a symbol imitate a path or an address.
 */
const SYMBOL_PATTERN = /^[A-Za-z0-9._-]{1,12}$/u;

/**
 * Validates contract-reported token metadata. The contract is chosen by the
 * dapp and fully attacker-controllable, so its answers are untrusted input:
 * an oversized `decimals` would hang balance formatting, and an unprintable
 * or overlong `symbol` could spoof the balance display.
 *
 * @param symbol - The contract-reported symbol.
 * @param decimals - The contract-reported decimals.
 * @returns The validated metadata, or null when out of bounds.
 */
export function sanitizeTokenMetadata(
  symbol: unknown,
  decimals: unknown,
): TokenMetadata | null {
  if (
    typeof symbol !== 'string' ||
    !SYMBOL_PATTERN.test(symbol) ||
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_TOKEN_DECIMALS
  ) {
    return null;
  }
  return { symbol, decimals };
}

/**
 * Reads a token's SEP-41 metadata (`symbol`, `decimals`) via simulation.
 *
 * @param network - The active network config.
 * @param contractId - The token contract address.
 * @returns The metadata, or null when it cannot be read or fails validation.
 */
export async function readTokenMetadata(
  network: NetworkConfig,
  contractId: string,
): Promise<TokenMetadata | null> {
  const [symbol, decimals] = await Promise.all([
    readContract(network, contractId, 'symbol', []),
    readContract(network, contractId, 'decimals', []),
  ]);
  return sanitizeTokenMetadata(symbol, decimals);
}

/**
 * Renders a raw i128 token amount as a decimal string at the token's
 * precision. Exported so the formatting can be tested directly: it is
 * otherwise reachable only behind a simulation round-trip, and the value it
 * formats is contract-reported and fully attacker-controllable.
 *
 * @param value - The raw amount in the token's smallest unit.
 * @param decimals - The token's decimal precision (already bounds-checked).
 * @returns The decimal string.
 */
export function formatTokenAmount(value: bigint, decimals: number): string {
  if (decimals === 0) {
    return value.toString();
  }
  // Format the magnitude and reattach the sign. BigInt division and remainder
  // both truncate toward zero, so a negative balance would otherwise carry its
  // sign into the fractional part and render as `-1.-5`. No real token should
  // report a negative balance, but a hostile one can choose to, and a
  // malformed balance row is a display-integrity defect either way.
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = magnitude / divisor;
  const fraction = (magnitude % divisor)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/u, '');
  // The sign is applied to the rendered string, not to `whole`: a magnitude
  // below 1 has `whole === 0n`, and `-0n` stringifies as `0`, which would drop
  // the sign entirely (`-0.5` rendering as `0.5`).
  const sign = negative ? '-' : '';
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/**
 * Reads an account's token balance via simulation and formats it with the
 * token's decimals.
 *
 * @param network - The active network config.
 * @param contractId - The token contract address.
 * @param address - The `G...` account to query.
 * @param decimals - The token's decimal precision.
 * @returns The decimal balance string, or null when it cannot be read.
 */
export async function readTokenBalance(
  network: NetworkConfig,
  contractId: string,
  address: string,
  decimals: number,
): Promise<string | null> {
  // Defense in depth against corrupt state: metadata is validated when the
  // token is added, but the exponentiation below must never see a bad value.
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_TOKEN_DECIMALS
  ) {
    return null;
  }
  const raw = await readContract(network, contractId, 'balance', [
    new Address(address).toScVal(),
  ]);
  if (raw === null || raw === undefined) {
    return null;
  }
  // i128 decodes to a bigint (or number for small values). Anything else is
  // a contract returning a shape `balance()` does not have, and the
  // conversion must not paper over it: `BigInt(true)` is `1n`, so a contract
  // returning a boolean would otherwise display as one smallest unit.
  const value = toBalanceBigInt(raw);
  if (value === null) {
    return null;
  }
  return formatTokenAmount(value, decimals);
}

/** The signed 128-bit range a SEP-41 `balance()` is defined to return. */
const I128_MAX = 2n ** 127n - 1n;
const I128_MIN = -(2n ** 127n);

/**
 * Narrows a decoded contract return value to the integer a token balance is
 * allowed to be: a bigint or a safe-integer number (the shapes `scValToNative`
 * produces for the integer ScVal variants), within the `i128` range a SEP-41
 * balance is defined in. Everything else is rejected rather than coerced:
 * booleans, floats, objects, and strings, including a string of digits. A
 * digit string is not a shape a real balance ever decodes to, and accepting
 * one handed the contract (or the endpoint answering for it) an unbounded
 * integer to parse, divide, and render on every balance read. The range
 * check refuses the wider `u256`/`i256` variants the same way: a contract
 * answering `balance()` with one is not reporting a balance.
 *
 * @param raw - The natively decoded return value.
 * @returns The balance as a bigint, or null when the value is not one.
 */
function toBalanceBigInt(raw: unknown): bigint | null {
  let value: bigint;
  if (typeof raw === 'bigint') {
    value = raw;
  } else if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
    value = BigInt(raw);
  } else {
    return null;
  }
  return value >= I128_MIN && value <= I128_MAX ? value : null;
}

/**
 * Reads a token's self-reported `name()` via simulation, best effort.
 *
 * The name is as forgeable as the symbol and is never displayed as such. Its
 * one use is as a claim that can be verified: a Stellar Asset Contract names
 * itself `CODE:ISSUER` (or `native`), and the snap can derive which contract
 * address that asset's SAC has, so a matching name proves the contract is
 * that asset. See `verifiedStellarAssetIdentity` in `./events`.
 *
 * @param network - The active network config.
 * @param contractId - The token contract address.
 * @returns The name when it is a short plain string, otherwise null.
 */
export async function readTokenName(
  network: NetworkConfig,
  contractId: string,
): Promise<string | null> {
  const name = await readContract(network, contractId, 'name', []);
  // A SAC name is `CODE:ISSUER` (at most 12 + 1 + 56 characters); anything
  // longer cannot be one and is not worth carrying further.
  return typeof name === 'string' && name.length <= 80 ? name : null;
}

/**
 * Whether a string is a Soroban contract address.
 *
 * Uses the SDK's strkey decoder rather than a shape regex, so the CRC16
 * checksum is verified, not just the version byte and base32 alphabet. That
 * is the same standard `StellarAddress` applies to `G...` addresses in
 * `src/rpc/validation.ts`; one concept, one validator. A shape-only check let
 * a mistyped or truncated ID through to two metadata simulations that could
 * only fail, spending rate-limiter slots and returning "could not read the
 * token contract, the network may be unreachable" for what is really a
 * malformed input.
 *
 * `StrKey.isValidContract` returns false rather than throwing on malformed
 * input, so this stays a total predicate.
 *
 * @param value - The string to test.
 * @returns True when it is a valid `C...` strkey.
 */
export const isContractId = (value: string): boolean =>
  StrKey.isValidContract(value);
