import { describe, expect, it, jest } from '@jest/globals';

import { getLatestLedger, sendTransaction, simulateTransaction } from './rpc';

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

  it('rejects a sequence the protocol cannot represent', async () => {
    // A ledger sequence is a uint32 on the wire, and this value bounds how
    // long an authorization signature stays valid. A height above that range
    // cannot be a ledger, and a value that passes an integer check only
    // because it lost precision is not exact enough to do arithmetic on.
    mockFetch(mockResponse(rpcResult({ sequence: 0x1_0000_0000 })));
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Malformed Stellar RPC response (getLatestLedger).',
    );

    mockFetch(mockResponse(rpcResult({ sequence: 2 ** 53 })));
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Malformed Stellar RPC response (getLatestLedger).',
    );
  });

  it('accepts the exact uint32 ceiling', async () => {
    mockFetch(mockResponse(rpcResult({ sequence: 0xffff_ffff })));
    expect(await getLatestLedger(RPC)).toBe(0xffff_ffff);
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

  it('refuses a response that does not declare JSON-RPC 2.0', async () => {
    // The version member is part of what makes the body a reply to this
    // protocol at all; a body without it (or with another version) is not a
    // JSON-RPC 2.0 response, however plausible its result looks.
    mockFetch(mockResponse({ id: 1, result: { sequence: 4321 } }));
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Malformed Stellar RPC response (getLatestLedger).',
    );
    mockFetch(
      mockResponse({ jsonrpc: '1.0', id: 1, result: { sequence: 4321 } }),
    );
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Malformed Stellar RPC response (getLatestLedger).',
    );
  });

  it('refuses a response carrying both result and error members', async () => {
    // JSON-RPC 2.0 makes the two mutually exclusive; a body answering both
    // ways at once is malformed, and neither half may be believed.
    mockFetch(
      mockResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { sequence: 4321 },
        error: { message: 'boom' },
      }),
    );
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Malformed Stellar RPC response (getLatestLedger).',
    );
  });

  it('refuses a response whose id is not the one the request carried', async () => {
    // A body answering some other request is not this call's reply, however
    // well formed its result is.
    mockFetch(
      mockResponse({ jsonrpc: '2.0', id: 2, result: { sequence: 4321 } }),
    );
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Malformed Stellar RPC response (getLatestLedger).',
    );
    mockFetch(mockResponse({ jsonrpc: '2.0', result: { sequence: 4321 } }));
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Malformed Stellar RPC response (getLatestLedger).',
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

  it('rejects a latestLedger that is not a positive integer', async () => {
    // A ledger height is what bounds signature lifetimes elsewhere, so this
    // field must carry the same guarantee as every other validated height:
    // a hostile endpoint cannot hand a consumer zero, a negative, or a
    // fractional "height".
    mockFetch(mockResponse(rpcResult({ latestLedger: 0 })));
    await expect(simulateTransaction(RPC, 'AAAA')).rejects.toThrow(
      'Malformed Stellar RPC response (simulateTransaction).',
    );

    mockFetch(mockResponse(rpcResult({ latestLedger: 99.5 })));
    await expect(simulateTransaction(RPC, 'AAAA')).rejects.toThrow(
      'Malformed Stellar RPC response (simulateTransaction).',
    );

    // Nor one the protocol cannot represent: a ledger sequence is a uint32.
    mockFetch(mockResponse(rpcResult({ latestLedger: 0x1_0000_0000 })));
    await expect(simulateTransaction(RPC, 'AAAA')).rejects.toThrow(
      'Malformed Stellar RPC response (simulateTransaction).',
    );
  });
});

describe('envelope id on error responses', () => {
  it('refuses an error envelope that answers some other request', async () => {
    // The id is checked before anything else in the body is believed, the
    // error member included: a body answering another request is not this
    // call's reply, and its error text has no more business reaching a
    // dialog than its result would.
    mockFetch(
      mockResponse({
        jsonrpc: '2.0',
        id: 2,
        error: { message: 'a failure that belongs to someone else' },
      }),
    );
    await expect(getLatestLedger(RPC)).rejects.toThrow(
      'Malformed Stellar RPC response (getLatestLedger).',
    );
  });
});
