import { describe, expect, it, jest } from '@jest/globals';

import { MAX_RESPONSE_BYTES, readJsonBounded } from './http';

type FetchResponse = Parameters<typeof readJsonBounded>[0];

/**
 * Builds a response-like object whose body streams the given chunks.
 *
 * @param chunks - Byte chunks the reader yields in order.
 * @param contentLength - Optional declared Content-Length header.
 * @returns The fake response and the reader's cancel spy.
 */
function streamingResponse(chunks: Uint8Array[], contentLength?: number) {
  let index = 0;
  const cancel = jest.fn(async () => undefined);
  const response = {
    headers: {
      get: (name: string) =>
        name === 'content-length' && contentLength !== undefined
          ? String(contentLength)
          : null,
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) {
            return { done: true };
          }
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
        cancel,
      }),
    },
    text: async () => {
      throw new Error('text() must not be used when a stream is available');
    },
  } as unknown as FetchResponse;
  return { response, cancel };
}

/**
 * Builds a response-like object without a body stream (buffered fallback).
 *
 * @param text - The body text.
 * @returns The fake response.
 */
function bufferedResponse(text: string): FetchResponse {
  return {
    headers: { get: () => null },
    body: null,
    text: async () => text,
  } as unknown as FetchResponse;
}

describe('readJsonBounded', () => {
  it('parses a streamed JSON body under the cap', async () => {
    const { response } = streamingResponse([
      Buffer.from('{"sequ'),
      Buffer.from('ence": 42}'),
    ]);
    expect(await readJsonBounded(response, 'Test')).toStrictEqual({
      sequence: 42,
    });
  });

  it('rejects an oversized declared Content-Length before reading', async () => {
    const { response } = streamingResponse([], MAX_RESPONSE_BYTES + 1);
    await expect(readJsonBounded(response, 'Test')).rejects.toThrow(
      'oversized',
    );
  });

  it('aborts a stream the moment it exceeds the cap', async () => {
    // No Content-Length declared; the stream must be cut off mid-read.
    const chunk = new Uint8Array(64 * 1024);
    const chunks = Array.from(
      { length: MAX_RESPONSE_BYTES / chunk.length + 1 },
      () => chunk,
    );
    const { response, cancel } = streamingResponse(chunks);
    await expect(readJsonBounded(response, 'Test')).rejects.toThrow(
      'oversized',
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('enforces the cap on the buffered fallback path', async () => {
    const oversized = 'x'.repeat(MAX_RESPONSE_BYTES + 1);
    await expect(
      readJsonBounded(bufferedResponse(oversized), 'Test'),
    ).rejects.toThrow('oversized');
  });

  it('returns null for a non-JSON body', async () => {
    expect(
      await readJsonBounded(bufferedResponse('not json'), 'Test'),
    ).toBeNull();
  });
});
