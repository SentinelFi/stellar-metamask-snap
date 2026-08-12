import { externalServiceError } from '../rpc/errors';

/**
 * Minimal Stellar RPC (JSON-RPC 2.0) client. Hand-rolled over `fetch` to
 * keep the bundle small — the stellar-sdk `rpc.Server` pulls in transport
 * machinery the snap does not need.
 */

/** Raw shape of a `simulateTransaction` response (fields we consume). */
export type RawSimulationResponse = {
  error?: string;
  transactionData?: string;
  minResourceFee?: string;
  results?: { xdr?: string; auth?: string[] }[];
  restorePreamble?: { transactionData: string; minResourceFee: string };
  latestLedger?: number;
};

export type SendTransactionResponse = {
  status: 'PENDING' | 'DUPLICATE' | 'TRY_AGAIN_LATER' | 'ERROR';
  hash: string;
  errorResultXdr?: string;
};

export type GetTransactionResponse = {
  status: 'NOT_FOUND' | 'SUCCESS' | 'FAILED';
  resultXdr?: string;
};

/** Simulation timeout — keep dialog latency bounded. */
const SIMULATION_TIMEOUT_MS = 10_000;

/** Default timeout for every other RPC call, so none can hang. */
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/**
 * Performs a JSON-RPC 2.0 call.
 *
 * @param url - The RPC endpoint.
 * @param method - The JSON-RPC method.
 * @param params - The method params.
 * @param timeoutMs - Request timeout; defaults so no call is unbounded.
 * @returns The `result` member of the response.
 */
async function rpcCall<Type>(
  url: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): Promise<Type> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
  } catch {
    throw externalServiceError(`Could not reach the Stellar RPC (${method}).`);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  if (!response.ok) {
    throw externalServiceError(
      `Stellar RPC request failed (${response.status}).`,
    );
  }

  const body = (await response.json()) as {
    result?: Type;
    error?: { message?: string };
  };
  if (body.error || body.result === undefined) {
    throw externalServiceError(
      `Stellar RPC error: ${body.error?.message ?? 'empty result'}.`,
    );
  }
  return body.result;
}

/**
 * `getLatestLedger` — used to default auth-entry expirations.
 *
 * @param url - The RPC endpoint.
 * @returns The latest ledger sequence.
 */
export async function getLatestLedger(url: string): Promise<number> {
  const result = await rpcCall<{ sequence: number }>(
    url,
    'getLatestLedger',
    {},
  );
  return result.sequence;
}

/**
 * `simulateTransaction` — display-verification simulation of a Soroban
 * transaction (the snap never mutates the transaction it signs).
 *
 * @param url - The RPC endpoint.
 * @param transactionXdr - Base64 envelope XDR (single Soroban operation).
 * @returns The raw simulation response.
 */
export async function simulateTransaction(
  url: string,
  transactionXdr: string,
): Promise<RawSimulationResponse> {
  return rpcCall<RawSimulationResponse>(
    url,
    'simulateTransaction',
    { transaction: transactionXdr },
    SIMULATION_TIMEOUT_MS,
  );
}

/**
 * `sendTransaction` — submit a signed envelope through the RPC.
 *
 * @param url - The RPC endpoint.
 * @param transactionXdr - Signed base64 envelope XDR.
 * @returns The send response (PENDING means enqueued, not final).
 */
export async function sendTransaction(
  url: string,
  transactionXdr: string,
): Promise<SendTransactionResponse> {
  return rpcCall<SendTransactionResponse>(url, 'sendTransaction', {
    transaction: transactionXdr,
  });
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
  return rpcCall<GetTransactionResponse>(url, 'getTransaction', { hash });
}
