import { beforeEach, describe, expect, it } from '@jest/globals';

import {
  assertRateAllowed,
  MAX_INFLIGHT_GLOBAL,
  MAX_INFLIGHT_PER_ORIGIN,
  MAX_INFLIGHT_UNCONNECTED,
  MAX_PREDIALOG_LOOKUPS,
  MAX_PREDIALOG_UNCONNECTED,
  RATE_LIMITS,
  resetRequestLimits,
  takePredialogBudget,
  withInflightBudget,
} from './limiter';

/** Budget claim by an origin holding a standing connection grant. */
const CONNECTED = true;
/** Budget claim by a cold-callable origin with no grant. */
const COLD = false;

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
      expect(takePredialogBudget(CONNECTED)).toBe(true);
    }
    expect(takePredialogBudget(CONNECTED)).toBe(false);
  });

  it('is origin-independent, so subdomain rotation cannot reset it', () => {
    // This is the whole point of the budget: every other control here is
    // keyed on `origin`, and the snap cannot distinguish `a1.example` from
    // `a2.example`, so a wildcard domain gets a fresh per-origin budget per
    // subdomain. The global budget is what survives that.
    for (let index = 0; index < MAX_PREDIALOG_LOOKUPS; index += 1) {
      takePredialogBudget(CONNECTED);
    }
    expect(takePredialogBudget(CONNECTED)).toBe(false);
  });

  it('claims a whole batch atomically or not at all', () => {
    // A caller about to run N lookups must not get a partial reservation:
    // it would spend budget it could not use and still be denied.
    expect(takePredialogBudget(CONNECTED, MAX_PREDIALOG_LOOKUPS - 1)).toBe(
      true,
    );
    expect(takePredialogBudget(CONNECTED, 5)).toBe(false);
    // The refused batch consumed nothing, so a batch that does fit still
    // passes.
    expect(takePredialogBudget(CONNECTED, 1)).toBe(true);
    expect(takePredialogBudget(CONNECTED, 1)).toBe(false);
  });

  it('caps cold callers below the full budget', () => {
    for (let index = 0; index < MAX_PREDIALOG_UNCONNECTED; index += 1) {
      expect(takePredialogBudget(COLD)).toBe(true);
    }
    expect(takePredialogBudget(COLD)).toBe(false);
  });

  it('keeps a share reserved that cold callers cannot drain', () => {
    // The finding this guards: the budget was one undifferentiated pool
    // claimed *before* any dialog opens, so a site rotating subdomains could
    // empty it with no user interaction and leave every other site's signing
    // dialog rendering "checks were skipped" for the rest of the window. A
    // caution an attacker can make permanent stops being a caution.
    for (let index = 0; index < MAX_PREDIALOG_UNCONNECTED * 4; index += 1) {
      takePredialogBudget(COLD);
    }
    // Cold callers are exhausted...
    expect(takePredialogBudget(COLD)).toBe(false);
    // ...but a connected origin still gets its full classic fan-out checked.
    expect(takePredialogBudget(CONNECTED, 6)).toBe(true);
  });

  it('lets connected origins draw on the reserved share only', () => {
    // The reserve is headroom above the cold ceiling, not a separate pool:
    // total work stays bounded by MAX_PREDIALOG_LOOKUPS however the claims
    // are split, so the anti-amplification property is preserved.
    for (let index = 0; index < MAX_PREDIALOG_UNCONNECTED; index += 1) {
      takePredialogBudget(COLD);
    }
    const reserved = MAX_PREDIALOG_LOOKUPS - MAX_PREDIALOG_UNCONNECTED;
    for (let index = 0; index < reserved; index += 1) {
      expect(takePredialogBudget(CONNECTED)).toBe(true);
    }
    expect(takePredialogBudget(CONNECTED)).toBe(false);
  });

  it('leaves the cold ceiling unchanged from before the split', () => {
    // The cold-callable surface is the unauthenticated one, so its
    // amplification bound must not have been loosened by adding headroom
    // above it.
    expect(MAX_PREDIALOG_UNCONNECTED).toBe(60);
    expect(MAX_PREDIALOG_LOOKUPS).toBeGreaterThan(MAX_PREDIALOG_UNCONNECTED);
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

  it('refuses unconnected requests beyond the reserved share', async () => {
    // Origin rotation must not multiply concurrency, and it must not be able
    // to consume the whole ceiling either: an unconnected caller stops at
    // MAX_INFLIGHT_UNCONNECTED, well below MAX_INFLIGHT_GLOBAL.
    const resolvers: (() => void)[] = [];
    const hold = async () =>
      new Promise<void>((resolve) => resolvers.push(resolve));

    const held = Array.from(
      { length: MAX_INFLIGHT_UNCONNECTED },
      async (_, index) =>
        withInflightBudget(`https://rotate-${index}.example`, hold),
    );
    await expect(
      withInflightBudget('https://one-more.example', async () => 'never'),
    ).rejects.toThrow('too many concurrent requests');

    for (const resolve of resolvers) {
      resolve();
    }
    await Promise.all(held);

    // Slots free up once the held requests settle.
    expect(
      await withInflightBudget('https://one-more.example', async () => 'ok'),
    ).toBe('ok');
  });

  it('reserves headroom above that share for connected origins', async () => {
    // The point of the split: an unconnected swarm filling its share must not
    // deny service to a site the user has actually approved.
    const resolvers: (() => void)[] = [];
    const hold = async () =>
      new Promise<void>((resolve) => resolvers.push(resolve));
    const connected = async () => true;

    const held = Array.from(
      { length: MAX_INFLIGHT_UNCONNECTED },
      async (_, index) =>
        withInflightBudget(`https://rotate-${index}.example`, hold),
    );

    // Cold caller: refused, the share is full.
    await expect(
      withInflightBudget('https://cold.example', async () => 'never'),
    ).rejects.toThrow('too many concurrent requests');
    // Connected caller: admitted, drawing on the reserved headroom.
    expect(
      await withInflightBudget(
        'https://granted.example',
        async () => 'ok',
        connected,
      ),
    ).toBe('ok');

    for (const resolve of resolvers) {
      resolve();
    }
    await Promise.all(held);
  });

  it('refuses connected requests beyond the global ceiling', async () => {
    // The reserved headroom is headroom, not an exemption.
    const resolvers: (() => void)[] = [];
    const hold = async () =>
      new Promise<void>((resolve) => resolvers.push(resolve));
    const connected = async () => true;

    const held = Array.from({ length: MAX_INFLIGHT_GLOBAL }, async (_, index) =>
      withInflightBudget(`https://rotate-${index}.example`, hold, connected),
    );
    await expect(
      withInflightBudget(
        'https://one-more.example',
        async () => 'never',
        connected,
      ),
    ).rejects.toThrow('too many concurrent requests');

    for (const resolve of resolvers) {
      resolve();
    }
    await Promise.all(held);
  });

  it('does not consult the grant below the reserved share', async () => {
    // Reading the grant costs a snap_manageState decrypt, so the common path
    // must not pay for it. Below the share the thunk is never called.
    let consulted = 0;
    const isConnected = async () => {
      consulted += 1;
      return false;
    };
    expect(
      await withInflightBudget(ORIGIN, async () => 'ok', isConnected),
    ).toBe('ok');
    expect(consulted).toBe(0);
  });

  it('keeps live in-flight counters intact under origin rotation', async () => {
    // The in-flight map must never evict a live counter: an origin holding
    // slots while many other origins come and go still has its count when it
    // asks for one slot too many.
    const resolvers: (() => void)[] = [];
    const hold = async () =>
      new Promise<void>((resolve) => resolvers.push(resolve));

    const held = Array.from({ length: MAX_INFLIGHT_PER_ORIGIN }, async () =>
      withInflightBudget(ORIGIN, hold),
    );
    for (let index = 0; index < 200; index += 1) {
      await withInflightBudget(`https://rotate-${index}.example`, async () => {
        return 'ok';
      });
    }
    await expect(
      withInflightBudget(ORIGIN, async () => 'never'),
    ).rejects.toThrow('Too many concurrent requests');

    for (const resolve of resolvers) {
      resolve();
    }
    await Promise.all(held);
  });
});
