import { externalServiceError } from '../rpc/errors';

/**
 * Upper bound on endpoint response bodies. Endpoint responses are
 * endpoint-controlled input: without a cap, a compromised Horizon or RPC
 * host could stream an arbitrarily large body and exhaust snap memory
 * (denial of service only, but cheap to prevent). 1 MiB is generous for
 * every consumed endpoint: the largest legitimate responses (accounts with
 * many trustlines, wasm-upload simulations) stay far below it.
 */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Reads a response body as JSON with a size cap: the declared
 * `Content-Length` is checked before the read, and the decoded text length
 * is checked after it (a hostile server can omit or understate the header).
 *
 * @param response - The fetch response.
 * @param service - Service name for error messages.
 * @returns The parsed JSON body, or null when the body is not valid JSON.
 * @throws An external-service `SnapError` when the body exceeds the cap.
 */
export async function readJsonBounded(
  response: Awaited<ReturnType<typeof fetch>>,
  service: string,
): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw externalServiceError(`${service} returned an oversized response.`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw externalServiceError(`${service} returned an oversized response.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
