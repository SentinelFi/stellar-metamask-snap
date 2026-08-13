import { Buffer } from 'buffer';

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

/** The subset of a body stream reader this module consumes. */
type BodyReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<unknown>;
};

/** The subset of a streamed body this module consumes. */
type StreamableBody = {
  body?: { getReader?: () => BodyReader } | null;
};

/**
 * Reads a response body incrementally, aborting as soon as the byte cap is
 * exceeded, so a hostile server that omits or understates `Content-Length`
 * cannot buffer an oversized body into memory first.
 *
 * @param reader - The body stream reader.
 * @param service - Service name for error messages.
 * @returns The decoded body text.
 * @throws An external-service `SnapError` when the cap is exceeded.
 */
async function readStreamBounded(
  reader: BodyReader,
  service: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw externalServiceError(
          `${service} returned an oversized response.`,
        );
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8',
  );
}

/**
 * Reads a response body as JSON with a byte cap enforced during the read:
 * the declared `Content-Length` is checked first, then the body is consumed
 * incrementally and aborted the moment it exceeds the cap. When the runtime
 * exposes no body stream, the buffered fallback still enforces the cap after
 * decoding (a hostile server can omit or understate the header either way).
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
    // Release the connection before reporting: the caller catches this and
    // clears its abort timer, and an unreleased body would then outlive the
    // timeout boundary the caller established.
    await discardBody(response);
    throw externalServiceError(`${service} returned an oversized response.`);
  }

  const { body } = response as unknown as StreamableBody;
  let text: string;
  if (body && typeof body.getReader === 'function') {
    text = await readStreamBounded(body.getReader(), service);
  } else {
    // No stream reader: the runtime buffers the whole body before the cap
    // can be applied, so this cannot prevent pre-buffer allocation — it only
    // refuses to hand oversized data onward. Count real bytes, not the
    // UTF-16 code units `text.length` would report.
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw externalServiceError(`${service} returned an oversized response.`);
    }
    text = Buffer.from(bytes).toString('utf8');
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Releases a response body the caller will not read.
 *
 * A response thrown away without being consumed or cancelled can keep its
 * connection open, outside the abort timer the caller is about to clear. A
 * hostile or malfunctioning endpoint can exploit that by answering with an
 * error status and then holding an endless body. Cancelling is best effort:
 * failing to release must never mask the error being reported.
 *
 * @param response - The response whose body will not be read.
 */
export async function discardBody(
  response: Awaited<ReturnType<typeof fetch>>,
): Promise<void> {
  try {
    const { body } = response as unknown as {
      body?: { cancel?: () => Promise<void> };
    };
    await body?.cancel?.();
  } catch {
    // Nothing useful to do here: the caller is already reporting a failure.
  }
}
