import { SnapError } from '@metamask/snaps-sdk';
import type { Infer, Struct } from '@metamask/superstruct';
import {
  array,
  enums,
  integer,
  is,
  min,
  number,
  optional,
  pattern,
  string,
  type,
} from '@metamask/superstruct';

import { discardBody, readJsonBounded } from './http';
import { externalServiceError } from '../rpc/errors';
import { sanitizeInlineText } from '../ui/format';

/**
 * Minimal Stellar RPC (JSON-RPC 2.0) client. Hand-rolled over `fetch` to
 * keep the bundle small — the stellar-sdk `rpc.Server` pulls in transport
 * machinery the snap does not need. Responses are endpoint-controlled
 * input: every consumed field is validated at this boundary before use.
 */

/** A 64-character hex transaction hash. */
const TxHash = pattern(string(), /^[0-9a-f]{64}$/iu);

const LatestLedgerStruct = type({ sequence: min(integer(), 1) });

const SimulationStruct = type({
  error: optional(string()),
  transactionData: optional(string()),
  minResourceFee: optional(pattern(string(), /^\d+$/u)),
  results: optional(
    array(type({ xdr: optional(string()), auth: optional(array(string())) })),
  ),
  /** Base64 `DiagnosticEvent` XDR: the token movements the call would make. */
  events: optional(array(string())),
  restorePreamble: optional(
    type({ transactionData: string(), minResourceFee: string() }),
  ),
  latestLedger: optional(number()),
});

const SendTransactionStruct = type({
  status: enums(['PENDING', 'DUPLICATE', 'TRY_AGAIN_LATER', 'ERROR']),
  hash: TxHash,
  errorResultXdr: optional(string()),
});

const GetTransactionStruct = type({
  status: enums(['NOT_FOUND', 'SUCCESS', 'FAILED']),
  resultXdr: optional(string()),
});

/** Raw shape of a `simulateTransaction` response (fields we consume). */
export type RawSimulationResponse = Infer<typeof SimulationStruct>;

export type SendTransactionResponse = Infer<typeof SendTransactionStruct>;

export type GetTransactionResponse = Infer<typeof GetTransactionStruct>;

/** Simulation timeout — keep dialog latency bounded. */
const SIMULATION_TIMEOUT_MS = 10_000;

/** Default timeout for every other RPC call, so none can hang. */
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/**
 * Performs a JSON-RPC 2.0 call and validates the result shape.
 *
 * The abort timer stays armed until the response body has been read, so a
 * host that returns headers quickly and then stalls the body cannot hold
 * the request open. Redirects are refused: a 307/308 must not replay
 * signing-related payloads to a different host.
 *
 * @param url - The RPC endpoint.
 * @param method - The JSON-RPC method.
 * @param params - The method params.
 * @param resultStruct - Validator for the `result` member.
 * @param timeoutMs - Request timeout; defaults so no call is unbounded.
 * @returns The validated `result` member of the response.
 */
async function rpcCall<Type, Schema>(
  url: string,
  method: string,
  params: Record<string, unknown>,
  resultStruct: Struct<Type, Schema>,
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): Promise<Type> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let status: number;
  let ok: boolean;
  let body: unknown;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      redirect: 'error',
      signal: controller.signal,
    });
    ({ status, ok } = response);
    if (ok) {
      body = await readJsonBounded(response, 'Stellar RPC');
    } else {
      // Release the connection while the abort timer is still armed. Dropping
      // an unread body here would let an error status with an endless body
      // outlive the timeout boundary this function establishes.
      await discardBody(response);
      body = null;
    }
  } catch (error) {
    // readJsonBounded throws a typed oversized-response error; keep it.
    if (error instanceof SnapError) {
      throw error;
    }
    throw externalServiceError(`Could not reach the Stellar RPC (${method}).`);
  } finally {
    clearTimeout(timer);
  }

  if (!ok) {
    throw externalServiceError(`Stellar RPC request failed (${status}).`);
  }

  const envelope = body as {
    result?: unknown;
    error?: { message?: string };
  } | null;
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    envelope.error ||
    envelope.result === undefined
  ) {
    throw externalServiceError(
      // The endpoint's message is untrusted display text: strip control and
      // direction-altering characters before it can reach an error surface.
      `Stellar RPC error: ${
        typeof envelope?.error?.message === 'string'
          ? sanitizeInlineText(envelope.error.message).slice(0, 200)
          : 'empty result'
      }.`,
    );
  }
  if (!is(envelope.result, resultStruct)) {
    throw externalServiceError(`Malformed Stellar RPC response (${method}).`);
  }
  return envelope.result;
}

/**
 * `getLatestLedger` — used to default auth-entry expirations.
 *
 * @param url - The RPC endpoint.
 * @returns The latest ledger sequence.
 */
export async function getLatestLedger(url: string): Promise<number> {
  const result = await rpcCall(url, 'getLatestLedger', {}, LatestLedgerStruct);
  return result.sequence;
}

/**
 * `simulateTransaction` — display-verification simulation of a Soroban
 * transaction (the snap never mutates the transaction it signs).
 *
 * @param url - The RPC endpoint.
 * @param transactionXdr - Base64 envelope XDR (single Soroban operation).
 * @param timeoutMs - Optional caller-supplied timeout (e.g. token reads use
 * a tighter budget); the abort covers the whole request, so no background
 * work outlives it.
 * @returns The raw simulation response.
 */
export async function simulateTransaction(
  url: string,
  transactionXdr: string,
  timeoutMs: number = SIMULATION_TIMEOUT_MS,
): Promise<RawSimulationResponse> {
  return rpcCall(
    url,
    'simulateTransaction',
    { transaction: transactionXdr },
    SimulationStruct,
    timeoutMs,
  );
}

/**
 * `sendTransaction` — submit a signed envelope through the RPC. The status
 * is allowlisted at the boundary, so an unexpected value can never be
 * mistaken for acceptance downstream.
 *
 * @param url - The RPC endpoint.
 * @param transactionXdr - Signed base64 envelope XDR.
 * @returns The send response (PENDING means enqueued, not final).
 */
export async function sendTransaction(
  url: string,
  transactionXdr: string,
): Promise<SendTransactionResponse> {
  return rpcCall(
    url,
    'sendTransaction',
    { transaction: transactionXdr },
    SendTransactionStruct,
  );
}

/**
 * `getTransaction` — poll a submitted transaction's status.
 *
 * @param url - The RPC endpoint.
 * @param hash - The transaction hash (hex).
 * @returns The transaction status response.
 */
export async function getTransaction(
  url: string,
  hash: string,
): Promise<GetTransactionResponse> {
  return rpcCall(url, 'getTransaction', { hash }, GetTransactionStruct);
}
