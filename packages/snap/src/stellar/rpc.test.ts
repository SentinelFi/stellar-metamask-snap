import { describe, expect, it, jest } from '@jest/globals';

import {
  getLatestLedger,
  getTransaction,
  sendTransaction,
  simulateTransaction,
} from './rpc';

const RPC = 'https://soroban-testnet.stellar.org';
const TX_HASH = 'b'.repeat(64);

/**
 * Builds the minimal response surface the RPC client consumes (buffered
 * body; no stream reader, so readJsonBounded takes its arrayBuffer path).
 *
 * @param body - The JSON body.
 * @param options - Status overrides.
 * @param options.status - HTTP status (default 200).
 * @returns The mock response.
 */
function mockResponse(body: unknown, options: { status?: number } = {}) {
  const status = options.status ?? 200;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer,
  };
}

/**
 * Wraps a payload in a JSON-RPC 2.0 result envelope.
 *
 * @param result - The result member.
 * @returns The envelope.
 */
function rpcResult(result: unknown) {
  return { jsonrpc: '2.0', id: 1, result };
}

/**
 * Installs a fetch mock answering every request with the given response (or
 * throwing when given an Error).
 *
 * @param result - The response to return, or an error to throw.
 * @returns The installed mock, for call-shape assertions.
 */
function mockFetch(result: unknown) {
  const mocked = jest.fn(async () => {
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  (globalThis as { fetch?: unknown }).fetch = mocked;
  return mocked;
}

describe('getLatestLedger', () => {
  it('returns the validated sequence', async () => {
    const mocked = mockFetch(mockResponse(rpcResult({ sequence: 4321 })));
    expect(await getLatestLedger(RPC)).toBe(4321);

    // The call itself must refuse redirects and carry an abort signal: a
    // 307/308 must not replay signing-related payloads to another host, and
    // no call may hang past its timeout.
    const [url, init] = mocked.mock.calls[0] as unknown as [
      string,
      { method: string; redirect?: string; signal?: unknown },
    ];
    expect(url).toBe(RPC);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });

  it('rejects non-positive or malformed sequences', async () => {
    mockFetch(mockResponse(rpcResult({ sequence: 0 })));
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Malformed Stellar RPC response (getLatestLedger).',
    );
  });

  it('sanitizes endpoint error messages before rethrowing them', async () => {
    mockFetch(
      mockResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { message: 'boom‮​hidden' },
      }),
    );
    const error = await getLatestLedger(RPC).catch((caught: Error) => caught);
    expect((error as Error).message).toContain('boom');
    expect((error as Error).message).not.toContain('‮');
    expect((error as Error).message).not.toContain('​');
  });

  it('reports HTTP failures and unreachable endpoints distinctly', async () => {
    mockFetch(mockResponse({}, { status: 502 }));
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Stellar RPC request failed (502).',
    );

    mockFetch(new Error('offline'));
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Could not reach the Stellar RPC (getLatestLedger).',
    );
  });

  it('treats a missing result member as an endpoint error', async () => {
    mockFetch(mockResponse({ jsonrpc: '2.0', id: 1 }));
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Stellar RPC error: empty result.',
    );
  });
});

describe('sendTransaction', () => {
  it('returns an allowlisted status with a validated hash', async () => {
    mockFetch(mockResponse(rpcResult({ status: 'PENDING', hash: TX_HASH })));
    expect(await sendTransaction(RPC, 'AAAA')).toStrictEqual({
      status: 'PENDING',
      hash: TX_HASH,
    });
  });

  it('rejects unexpected statuses so they cannot read as acceptance', async () => {
    mockFetch(mockResponse(rpcResult({ status: 'ACCEPTED??', hash: TX_HASH })));
    await expect(sendTransaction(RPC, 'AAAA')).rejects.toThrow(
      'Malformed Stellar RPC response (sendTransaction).',
    );
  });

  it('rejects malformed transaction hashes', async () => {
    mockFetch(mockResponse(rpcResult({ status: 'PENDING', hash: 'zz' })));
    await expect(sendTransaction(RPC, 'AAAA')).rejects.toThrow(
      'Malformed Stellar RPC response (sendTransaction).',
    );
  });
});

describe('getTransaction', () => {
  it('returns the validated status envelope', async () => {
    mockFetch(
      mockResponse(rpcResult({ status: 'SUCCESS', resultXdr: 'AAAA' })),
    );
    expect(await getTransaction(RPC, TX_HASH)).toStrictEqual({
      status: 'SUCCESS',
      resultXdr: 'AAAA',
    });
  });
});

describe('simulateTransaction', () => {
  it('returns the fields the snap consumes', async () => {
    mockFetch(
      mockResponse(
        rpcResult({
          transactionData: 'DATA',
          minResourceFee: '100',
          results: [{ xdr: 'RESULT', auth: ['AUTH'] }],
          latestLedger: 99,
        }),
      ),
    );
    expect(await simulateTransaction(RPC, 'AAAA')).toStrictEqual({
      transactionData: 'DATA',
      minResourceFee: '100',
      results: [{ xdr: 'RESULT', auth: ['AUTH'] }],
      latestLedger: 99,
    });
  });

  it('rejects malformed simulation shapes', async () => {
    mockFetch(mockResponse(rpcResult({ minResourceFee: 100 })));
    await expect(simulateTransaction(RPC, 'AAAA')).rejects.toThrow(
      'Malformed Stellar RPC response (simulateTransaction).',
    );
  });
});
