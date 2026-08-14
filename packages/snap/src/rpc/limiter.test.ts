import { beforeEach, describe, expect, it } from '@jest/globals';

import {
  assertRateAllowed,
  MAX_INFLIGHT_PER_ORIGIN,
  RATE_LIMITS,
  resetRequestLimits,
  withInflightBudget,
} from './limiter';

const ORIGIN = 'https://dapp.example';

// Resolved at module scope so no conditional logic lives inside a test.
const FUND_LIMIT = (RATE_LIMITS.get('fund') as { limit: number }).limit;
const BALANCES_LIMIT = (RATE_LIMITS.get('getBalances') as { limit: number })
  .limit;
const ADD_TOKEN_LIMIT = (RATE_LIMITS.get('addToken') as { limit: number })
  .limit;

describe('assertRateAllowed', () => {
  beforeEach(() => {
    resetRequestLimits();
  });

  it('lets unlimited methods through', () => {
    for (let index = 0; index < 100; index += 1) {
      expect(() => assertRateAllowed(ORIGIN, 'getAddress')).not.toThrow();
    }
  });

  it('throttles fund once its window limit is reached', () => {
    for (let index = 0; index < FUND_LIMIT; index += 1) {
      expect(() => assertRateAllowed(ORIGIN, 'fund')).not.toThrow();
    }
    expect(() => assertRateAllowed(ORIGIN, 'fund')).toThrow(
      'Too many fund requests',
    );
  });

  it('throttles getBalances once its window limit is reached', () => {
    for (let index = 0; index < BALANCES_LIMIT; index += 1) {
      expect(() => assertRateAllowed(ORIGIN, 'getBalances')).not.toThrow();
    }
    expect(() => assertRateAllowed(ORIGIN, 'getBalances')).toThrow(
      'Too many getBalances requests',
    );
  });

  it('throttles addToken once its window limit is reached', () => {
    // Regression: addToken runs two metadata simulations before any dialog,
    // and a non-token contract ID fails before a dialog opens, so without a
    // window limit a connected origin could drive unbounded RPC traffic.
    for (let index = 0; index < ADD_TOKEN_LIMIT; index += 1) {
      expect(() => assertRateAllowed(ORIGIN, 'addToken')).not.toThrow();
    }
    expect(() => assertRateAllowed(ORIGIN, 'addToken')).toThrow(
      'Too many addToken requests',
    );
  });

  it('tracks origins independently', () => {
    for (let index = 0; index < FUND_LIMIT; index += 1) {
      assertRateAllowed(ORIGIN, 'fund');
    }
    expect(() =>
      assertRateAllowed('https://other.example', 'fund'),
    ).not.toThrow();
  });
});

describe('withInflightBudget', () => {
  beforeEach(() => {
    resetRequestLimits();
  });

  it('refuses requests beyond the per-origin concurrency cap', async () => {
    const resolvers: (() => void)[] = [];
    const hold = async () =>
      new Promise<void>((resolve) => resolvers.push(resolve));

    const held = Array.from({ length: MAX_INFLIGHT_PER_ORIGIN }, async () =>
      withInflightBudget(ORIGIN, hold),
    );
    // One more must be refused up front, not queued.
    await expect(
      withInflightBudget(ORIGIN, async () => 'never'),
    ).rejects.toThrow('Too many concurrent requests');

    // Another origin is unaffected.
    expect(
      await withInflightBudget('https://other.example', async () => 'ok'),
    ).toBe('ok');

    for (const resolve of resolvers) {
      resolve();
    }
    await Promise.all(held);

    // Slots free up once the held requests settle.
    expect(await withInflightBudget(ORIGIN, async () => 'again')).toBe('again');
  });

  it('releases its slot when the handler throws', async () => {
    for (let index = 0; index < MAX_INFLIGHT_PER_ORIGIN * 2; index += 1) {
      await expect(
        withInflightBudget(ORIGIN, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    }
    expect(await withInflightBudget(ORIGIN, async () => 'ok')).toBe('ok');
  });
});
