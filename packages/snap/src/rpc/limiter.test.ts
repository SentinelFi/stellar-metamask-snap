import { beforeEach, describe, expect, it } from '@jest/globals';

import {
  assertRateAllowed,
  MAX_INFLIGHT_PER_ORIGIN,
  MAX_PREDIALOG_LOOKUPS,
  RATE_LIMITS,
  resetRequestLimits,
  takePredialogBudget,
  withInflightBudget,
} from './limiter';

const ORIGIN = 'https://dapp.example';

// Resolved at module scope so no conditional logic lives inside a test.
const FUND_LIMIT = (RATE_LIMITS.get('fund') as { limit: number }).limit;
const BALANCES_LIMIT = (RATE_LIMITS.get('getBalances') as { limit: number })
  .limit;
const ADD_TOKEN_LIMIT = (RATE_LIMITS.get('addToken') as { limit: number })
  .limit;
const SIGN_TX_LIMIT = (RATE_LIMITS.get('signTransaction') as { limit: number })
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

  it('throttles the signing methods once their window limit is reached', () => {
    // The signing dialogs do not bound their own cost: each request derives a
    // key and (for signTransaction) fans out Horizon lookups or a simulation
    // before any dialog exists, and all three are callable without a
    // connection grant. The dialog throttle only engages after three
    // consecutive *rejections*, so a caller that never resolves a dialog
    // never reaches it.
    for (const method of ['signTransaction', 'signAuthEntry', 'signMessage']) {
      resetRequestLimits();
      for (let index = 0; index < SIGN_TX_LIMIT; index += 1) {
        expect(() => assertRateAllowed(ORIGIN, method)).not.toThrow();
      }
      expect(() => assertRateAllowed(ORIGIN, method)).toThrow(
        `Too many ${method} requests`,
      );
    }
  });

  it('tracks origins independently', () => {
    for (let index = 0; index < FUND_LIMIT; index += 1) {
      assertRateAllowed(ORIGIN, 'fund');
    }
    expect(() =>
      assertRateAllowed('https://other.example', 'fund'),
    ).not.toThrow();
  });

  it('keeps an active origin out of the eviction path', () => {
    // Regression: eviction ran in raw insertion order, so an attacker
    // rotating origins could evict an *active* origin's window. Eviction
    // fails open, so the evicted party loses its throttle: exactly backwards.
    for (let index = 0; index < FUND_LIMIT; index += 1) {
      assertRateAllowed(ORIGIN, 'fund');
    }
    // Fill the tracking map well past its 100-entry cap, touching ORIGIN
    // throughout so it stays the most recently used key.
    for (let index = 0; index < 300; index += 1) {
      assertRateAllowed(`https://rotate-${index}.example`, 'fund');
      expect(() => assertRateAllowed(ORIGIN, 'fund')).toThrow(
        'Too many fund requests',
      );
    }
  });
});

describe('takePredialogBudget', () => {
  beforeEach(() => {
    resetRequestLimits();
  });

  it('allows lookups up to the global budget', () => {
    for (let index = 0; index < MAX_PREDIALOG_LOOKUPS; index += 1) {
      expect(takePredialogBudget()).toBe(true);
    }
    expect(takePredialogBudget()).toBe(false);
  });

  it('is origin-independent, so subdomain rotation cannot reset it', () => {
    // This is the whole point of the budget: every other control here is
    // keyed on `origin`, and the snap cannot distinguish `a1.example` from
    // `a2.example`, so a wildcard domain gets a fresh per-origin budget per
    // subdomain. The global budget is what survives that.
    for (let index = 0; index < MAX_PREDIALOG_LOOKUPS; index += 1) {
      takePredialogBudget();
    }
    expect(takePredialogBudget()).toBe(false);
  });

  it('claims a whole batch atomically or not at all', () => {
    // A caller about to run N lookups must not get a partial reservation:
    // it would spend budget it could not use and still be denied.
    expect(takePredialogBudget(MAX_PREDIALOG_LOOKUPS - 1)).toBe(true);
    expect(takePredialogBudget(5)).toBe(false);
    // The refused batch consumed nothing, so a batch that does fit still
    // passes.
    expect(takePredialogBudget(1)).toBe(true);
    expect(takePredialogBudget(1)).toBe(false);
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
