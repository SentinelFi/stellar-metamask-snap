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

    const response = await Promise.race([
      simulateTransaction(network.sorobanRpcUrl, tx.toXDR()),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('timeout')), READ_TIMEOUT_MS);
      }),
    ]);

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
 * Reads a token's SEP-41 metadata (`symbol`, `decimals`) via simulation.
 *
 * @param network - The active network config.
 * @param contractId - The token contract address.
 * @returns The metadata, or null when it cannot be read.
 */
export async function readTokenMetadata(
  network: NetworkConfig,
  contractId: string,
): Promise<TokenMetadata | null> {
  const [symbol, decimals] = await Promise.all([
    readContract(network, contractId, 'symbol', []),
    readContract(network, contractId, 'decimals', []),
  ]);
  if (typeof symbol !== 'string' || typeof decimals !== 'number') {
    return null;
  }
  return { symbol, decimals };
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
  if (decimals === 0) {
    return value.toString();
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * Whether a string looks like a Soroban contract address.
 *
 * @param value - The string to test.
 * @returns True when it is a `C...` strkey.
 */
export const isContractId = (value: string): boolean =>
  /^C[A-Z2-7]{55}$/u.test(value);
