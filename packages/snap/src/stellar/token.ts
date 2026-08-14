import {
  Account,
  Address,
  Operation,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
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

/** Symbols must be short printable ASCII — no control/bidi spoofing chars. */
const SYMBOL_PATTERN = /^[!-~]{1,12}$/u;

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
  // i128 decodes to a bigint (or number for small values).
  let value: bigint;
  try {
    value = BigInt(raw as bigint | number | string);
  } catch {
    return null;
  }
  return formatTokenAmount(value, decimals);
}

/**
 * Whether a string looks like a Soroban contract address.
 *
 * @param value - The string to test.
 * @returns True when it is a `C...` strkey.
 */
export const isContractId = (value: string): boolean =>
  /^C[A-Z2-7]{55}$/u.test(value);
