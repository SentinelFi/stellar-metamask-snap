/* eslint-disable @typescript-eslint/naming-convention */
// Fixtures mirror Horizon's wire format, whose field names are snake_case.
import { describe, expect, it, jest } from '@jest/globals';

import {
  getAccountChecks,
  getAccountSummary,
  getHorizonLatestLedger,
  requestFriendbot,
  submitTransaction,
} from './horizon';

const HORIZON = 'https://horizon-testnet.stellar.org';
const ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVV';
const TX_HASH = 'a'.repeat(64);

/**
 * Builds the minimal response surface the horizon client consumes: status
 * flags, a headers lookup, and a buffered body (no stream reader, so
 * readJsonBounded takes its arrayBuffer fallback).
 *
 * @param body - The JSON body (or raw text via `options.text`).
 * @param options - Status/text overrides.
 * @param options.status - HTTP status (default 200).
 * @param options.text - Raw body text overriding JSON serialization.
 * @returns The mock response.
 */
function mockResponse(
  body: unknown,
  options: { status?: number; text?: string } = {},
) {
  const status = options.status ?? 200;
  const raw = options.text ?? JSON.stringify(body);
  const bytes = new TextEncoder().encode(raw);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer,
  };
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

describe('getAccountSummary', () => {
  it('maps a funded account, translating native and issued assets', async () => {
    mockFetch(
      mockResponse({
        sequence: '123456',
        balances: [
          { asset_type: 'native', balance: '10.5000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: ISSUER,
            balance: '2.0000000',
          },
        ],
      }),
    );

    expect(await getAccountSummary(HORIZON, ADDRESS)).toStrictEqual({
      funded: true,
      sequence: '123456',
      balances: [
        { asset: 'XLM', balance: '10.5000000', type: 'native' },
        { asset: `USDC:${ISSUER}`, balance: '2.0000000', type: 'classic' },
      ],
    });
  });

  it('marks classic rows so they cannot be confused with token rows', async () => {
    // Tracked Soroban tokens are appended to this same array in the same
    // `NAME:IDENTIFIER` shape, with a symbol the token contract chooses. The
    // `type` field is what keeps the two apart for a consumer that would
    // otherwise split on ':' and display the first field. A classic row must
    // never carry a contractId either, or the discriminator loses its meaning.
    mockFetch(
      mockResponse({
        sequence: '1',
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: ISSUER,
            balance: '2.0000000',
          },
        ],
      }),
    );
    const [row] = (await getAccountSummary(HORIZON, ADDRESS)).balances;
    expect(row?.type).toBe('classic');
    expect(row?.contractId).toBeUndefined();
  });

  it('treats 404 as an unfunded account, not an error', async () => {
    mockFetch(mockResponse({ status: 404 }, { status: 404 }));
    expect(await getAccountSummary(HORIZON, ADDRESS)).toStrictEqual({
      funded: false,
      sequence: null,
      balances: [],
    });
  });

  it('caps the balance list a hostile response can flood', async () => {
    mockFetch(
      mockResponse({
        sequence: '1',
        balances: Array.from({ length: 150 }, () => ({
          asset_type: 'native',
          balance: '1.0000000',
        })),
      }),
    );
    const summary = await getAccountSummary(HORIZON, ADDRESS);
    expect(summary.balances).toHaveLength(100);
    // The cut is disclosed, not silent: "asset absent from the list" and
    // "asset not held" must stay distinguishable for a legitimate account
    // holding more trustlines than the cap.
    expect(summary.balancesTruncated).toBe(true);
  });

  it('does not flag an uncut balance list as truncated', async () => {
    // The positive control: the flag has one spelling ("present and true"),
    // so an ordinary account must not carry it at all.
    mockFetch(
      mockResponse({
        sequence: '1',
        balances: [{ asset_type: 'native', balance: '1.0000000' }],
      }),
    );
    const summary = await getAccountSummary(HORIZON, ADDRESS);
    expect(summary.balancesTruncated).toBeUndefined();
  });

  it('refuses malformed account responses', async () => {
    mockFetch(mockResponse({ sequence: 'not-a-number', balances: [] }));
    await expect(getAccountSummary(HORIZON, ADDRESS)).rejects.toThrow(
      'Malformed Horizon account response.',
    );
  });

  it('surfaces non-ok statuses as external service errors', async () => {
    mockFetch(mockResponse({}, { status: 500 }));
    await expect(getAccountSummary(HORIZON, ADDRESS)).rejects.toThrow(
      'Horizon request failed (500).',
    );
  });

  it('refuses redirects and bounds the request with an abort signal', async () => {
    const mocked = mockFetch(mockResponse({ status: 404 }, { status: 404 }));
    await getAccountSummary(HORIZON, ADDRESS);
    const [, init] = mocked.mock.calls[0] as unknown as [
      string,
      { redirect?: string; signal?: unknown },
    ];
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });
});

describe('submitTransaction', () => {
  it('returns the hash of an accepted submission', async () => {
    mockFetch(mockResponse({ hash: TX_HASH }));
    expect(await submitTransaction(HORIZON, 'AAAA')).toStrictEqual({
      hash: TX_HASH,
    });
  });

  it('rejects an ok response without a well-formed hash', async () => {
    mockFetch(mockResponse({ hash: 'not-a-hash' }));
    await expect(submitTransaction(HORIZON, 'AAAA')).rejects.toThrow(
      'Transaction submission failed',
    );
  });

  it('sanitizes endpoint-controlled result codes in the error text', async () => {
    // A hostile Horizon can embed direction-altering characters in
    // extras.result_codes; they must not survive into the error message.
    mockFetch(
      mockResponse(
        {
          extras: {
            result_codes: { transaction: 'tx_failed‮​evil' },
          },
        },
        { status: 400 },
      ),
    );
    const error = await submitTransaction(HORIZON, 'AAAA').catch(
      (caught: Error) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Result codes');
    expect((error as Error).message).toContain('tx_failed');
    expect((error as Error).message).not.toContain('‮');
    expect((error as Error).message).not.toContain('​');
  });
});

describe('getAccountChecks', () => {
  it('reports a missing account as not existing', async () => {
    mockFetch(mockResponse({ status: 404 }, { status: 404 }));
    expect(await getAccountChecks(HORIZON, ADDRESS)).toStrictEqual({
      exists: false,
      memoRequired: false,
      signers: [],
      thresholds: null,
    });
  });

  it('extracts memo requirement, ed25519 signers, and thresholds', async () => {
    mockFetch(
      mockResponse({
        data: { 'config.memo_required': 'MQ==' },
        signers: [
          { key: ADDRESS, weight: 1, type: 'ed25519_public_key' },
          { key: 'XHASH', weight: 1, type: 'sha256_hash' },
        ],
        thresholds: {
          low_threshold: 1,
          med_threshold: 2,
          high_threshold: 3,
        },
      }),
    );

    expect(await getAccountChecks(HORIZON, ADDRESS)).toStrictEqual({
      exists: true,
      memoRequired: true,
      signers: [{ key: ADDRESS, weight: 1 }],
      thresholds: { low: 1, med: 2, high: 3 },
    });
  });

  it('degrades to null on malformed bodies, error statuses, and network failure', async () => {
    mockFetch(mockResponse({ signers: 'nope' }));
    expect(await getAccountChecks(HORIZON, ADDRESS)).toBeNull();

    mockFetch(mockResponse({}, { status: 503 }));
    expect(await getAccountChecks(HORIZON, ADDRESS)).toBeNull();

    mockFetch(new Error('offline'));
    expect(await getAccountChecks(HORIZON, ADDRESS)).toBeNull();
  });
});

describe('getHorizonLatestLedger', () => {
  it('returns the core ledger sequence from the root endpoint', async () => {
    mockFetch(mockResponse({ core_latest_ledger: 123_456 }));
    expect(await getHorizonLatestLedger(HORIZON)).toBe(123_456);
  });

  it('returns null on malformed, non-positive, error, or unreachable responses', async () => {
    // Best-effort second source: every failure degrades to null so the
    // caller can fall back to the other ledger source.
    mockFetch(mockResponse({ core_latest_ledger: 'high' }));
    expect(await getHorizonLatestLedger(HORIZON)).toBeNull();

    mockFetch(mockResponse({ core_latest_ledger: 0 }));
    expect(await getHorizonLatestLedger(HORIZON)).toBeNull();

    mockFetch(mockResponse({}, { status: 500 }));
    expect(await getHorizonLatestLedger(HORIZON)).toBeNull();

    mockFetch(new Error('offline'));
    expect(await getHorizonLatestLedger(HORIZON)).toBeNull();
  });
});

describe('requestFriendbot', () => {
  it('resolves on success and throws a helpful error otherwise', async () => {
    mockFetch(mockResponse({ ok: true }));
    expect(
      await requestFriendbot('https://friendbot.stellar.org', ADDRESS),
    ).toBeUndefined();

    mockFetch(mockResponse({}, { status: 400 }));
    await expect(
      requestFriendbot('https://friendbot.stellar.org', ADDRESS),
    ).rejects.toThrow('already be funded');
  });
});
