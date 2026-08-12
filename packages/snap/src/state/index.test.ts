import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  addToken,
  connectOrigin,
  isSafeStateKey,
  MAX_ACCOUNT_INDEX,
  MAX_TRACKED_TOKENS,
  nextAccountIndex,
  originHasGrant,
  parseState,
  revealAccount,
  setActiveAccount,
  setActiveNetwork,
} from '.';

const VALID_STATE = {
  version: 2,
  network: 'TESTNET',
  activeAccount: 0,
  accounts: [0],
  origins: { 'https://dapp.example': { connectedAt: '2026-08-11T00:00:00Z' } },
  tokens: {
    TESTNET: [
      {
        contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        symbol: 'USDC',
        decimals: 7,
      },
    ],
  },
};

const V1_STATE = {
  version: 1,
  network: 'TESTNET',
  origins: VALID_STATE.origins,
  tokens: VALID_STATE.tokens,
};

const DEFAULT_STATE = {
  version: 2,
  network: 'TESTNET',
  activeAccount: 0,
  accounts: [0],
  origins: {},
  tokens: {},
};

describe('parseState', () => {
  it('passes valid state through unchanged', () => {
    expect(parseState(VALID_STATE)).toStrictEqual(VALID_STATE);
    const multi = { ...VALID_STATE, activeAccount: 2, accounts: [0, 1, 2] };
    expect(parseState(multi)).toStrictEqual(multi);
  });

  it('accepts state without the optional tokens map', () => {
    const withoutTokens = {
      version: 2,
      network: 'TESTNET',
      activeAccount: 0,
      accounts: [0],
      origins: VALID_STATE.origins,
    };
    expect(parseState(withoutTokens)).toStrictEqual(withoutTokens);
  });

  it('migrates a valid version-1 state in place', () => {
    // A pre-multi-account wallet keeps its network, grants, and tokens, and
    // gains the default account fields, rather than resetting.
    expect(parseState(V1_STATE)).toStrictEqual(VALID_STATE);
  });

  it('resets to defaults on an unknown version', () => {
    // Regression: stored state used to be cast unchecked, so a downgrade
    // from a future state version would flow into signing/display paths.
    expect(parseState({ ...VALID_STATE, version: 3 })).toStrictEqual(
      DEFAULT_STATE,
    );
  });

  it('coerces a stray active account back to 0', () => {
    // An activeAccount outside the revealed set must not be trusted into
    // derivation and display paths.
    expect(
      parseState({ ...VALID_STATE, activeAccount: 5, accounts: [0, 1] }),
    ).toStrictEqual({ ...VALID_STATE, activeAccount: 0, accounts: [0, 1] });
  });

  it('normalizes the account set (dedupe, sort, always include 0)', () => {
    expect(
      parseState({ ...VALID_STATE, activeAccount: 1, accounts: [2, 1, 1] }),
    ).toStrictEqual({ ...VALID_STATE, activeAccount: 1, accounts: [0, 1, 2] });
  });

  it('resets on out-of-range or non-integer account indices', () => {
    expect(
      parseState({ ...VALID_STATE, accounts: [0, MAX_ACCOUNT_INDEX] }),
    ).toStrictEqual(DEFAULT_STATE);
    expect(parseState({ ...VALID_STATE, accounts: [0, -1] })).toStrictEqual(
      DEFAULT_STATE,
    );
    expect(parseState({ ...VALID_STATE, accounts: [0, 1.5] })).toStrictEqual(
      DEFAULT_STATE,
    );
    expect(parseState({ ...VALID_STATE, accounts: [] })).toStrictEqual(
      DEFAULT_STATE,
    );
    expect(parseState({ ...VALID_STATE, activeAccount: -1 })).toStrictEqual(
      DEFAULT_STATE,
    );
  });

  it('resets to defaults on structural corruption', () => {
    expect(parseState({ ...VALID_STATE, network: 'MAINNET' })).toStrictEqual(
      DEFAULT_STATE,
    );
    expect(parseState({ ...VALID_STATE, origins: 'oops' })).toStrictEqual(
      DEFAULT_STATE,
    );
    expect(
      parseState({
        ...VALID_STATE,
        tokens: { TESTNET: [{ contractId: 'C...', symbol: 7, decimals: 'x' }] },
      }),
    ).toStrictEqual(DEFAULT_STATE);
    expect(parseState('garbage')).toStrictEqual(DEFAULT_STATE);
    expect(parseState([])).toStrictEqual(DEFAULT_STATE);
  });
});

describe('origin grant key safety', () => {
  it('rejects prototype-chain keys', () => {
    expect(isSafeStateKey('https://dapp.example')).toBe(true);
    expect(isSafeStateKey('__proto__')).toBe(false);
    expect(isSafeStateKey('constructor')).toBe(false);
    expect(isSafeStateKey('prototype')).toBe(false);
  });

  it('reports a grant only for an own, non-prototype key', () => {
    const origins = {
      'https://dapp.example': { connectedAt: '2026-08-11T0:0Z' },
    };
    expect(originHasGrant(origins, 'https://dapp.example')).toBe(true);
    expect(originHasGrant(origins, 'https://other.example')).toBe(false);
    // Naive `origins[origin]` would return the inherited Object.prototype
    // here and wrongly report the origin as connected.
    expect(originHasGrant({}, '__proto__')).toBe(false);
    expect(originHasGrant({}, 'constructor')).toBe(false);
  });
});

describe('locked state mutations', () => {
  let stored: unknown;

  beforeEach(() => {
    stored = null;
    (globalThis as { snap?: unknown }).snap = {
      request: async (args: {
        method: string;
        params: { operation: string; newState?: unknown };
      }) => {
        // Yield a microtask before answering so that unserialized
        // read-modify-write sequences would actually interleave, matching
        // the async extension state store.
        await Promise.resolve();
        if (args.params.operation === 'get') {
          return stored;
        }
        stored = args.params.newState;
        return null;
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { snap?: unknown }).snap;
  });

  it('does not lose concurrent origin grants', async () => {
    // Regression: without the mutation lock, both calls read the
    // empty initial state and the second save clobbered the first grant.
    await Promise.all([
      connectOrigin('https://a.example'),
      connectOrigin('https://b.example'),
    ]);
    const state = stored as { origins: Record<string, unknown> };
    expect(Object.keys(state.origins).sort()).toStrictEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('setActiveNetwork re-reads state under the lock', async () => {
    // Regression: a network switch racing a grant write must keep
    // both effects, not resurrect the pre-dialog snapshot.
    stored = { version: 1, network: 'TESTNET', origins: {}, tokens: {} };
    await Promise.all([
      connectOrigin('https://a.example'),
      setActiveNetwork('PUBLIC'),
    ]);
    const state = stored as {
      network: string;
      origins: Record<string, unknown>;
    };
    expect(state.network).toBe('PUBLIC');
    expect(Object.keys(state.origins)).toStrictEqual(['https://a.example']);
  });

  it('addToken enforces the cap at commit time', async () => {
    const filler = Array.from({ length: MAX_TRACKED_TOKENS }, (_, index) => ({
      contractId: `C${String(index).padStart(55, 'A')}`,
      symbol: `T${index}`,
      decimals: 7,
    }));
    stored = {
      version: 1,
      network: 'TESTNET',
      origins: {},
      tokens: { TESTNET: filler },
    };

    // A distinct token beyond the cap is refused inside the locked
    // mutation, even though the handler's pre-dialog check was bypassed.
    await expect(
      addToken('TESTNET', {
        contractId: `C${'B'.repeat(55)}`,
        symbol: 'NEW',
        decimals: 7,
      }),
    ).rejects.toThrow('Token limit reached');
    expect(
      (stored as { tokens: Record<string, unknown[]> }).tokens.TESTNET,
    ).toHaveLength(MAX_TRACKED_TOKENS);

    // Re-adding an already-tracked token at the cap stays a quiet no-op.
    expect(
      await addToken('TESTNET', {
        contractId: `C${'0'.padStart(55, 'A')}`,
        symbol: 'T0',
        decimals: 7,
      }),
    ).toBe(false);
  });

  it('reveals only the next contiguous account index', async () => {
    await revealAccount(1);
    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0, 1]);

    // Re-revealing is a quiet no-op.
    await revealAccount(1);
    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0, 1]);

    // A stale approval (the set moved while the dialog was open) must not
    // add a different account than the one displayed.
    await expect(revealAccount(3)).rejects.toThrow(
      'The account list changed while the dialog was open.',
    );
    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0, 1]);
  });

  it('rejects revealing past the account cap', async () => {
    stored = {
      ...structuredClone(VALID_STATE),
      activeAccount: 0,
      accounts: Array.from({ length: MAX_ACCOUNT_INDEX }, (_, index) => index),
    };
    await expect(revealAccount(MAX_ACCOUNT_INDEX)).rejects.toThrow(
      'Account limit reached',
    );
  });

  it('switches only to revealed accounts', async () => {
    stored = { ...structuredClone(VALID_STATE), accounts: [0, 1] };
    await setActiveAccount(1);
    expect((stored as { activeAccount: number }).activeAccount).toBe(1);

    await expect(setActiveAccount(2)).rejects.toThrow('Unknown account index.');
    expect((stored as { activeAccount: number }).activeAccount).toBe(1);
  });

  it('does not drop writes on concurrent add and switch', async () => {
    stored = { ...structuredClone(VALID_STATE), accounts: [0, 1] };
    await Promise.all([revealAccount(2), setActiveAccount(1)]);
    const state = stored as { accounts: number[]; activeAccount: number };
    expect(state.accounts).toStrictEqual([0, 1, 2]);
    expect(state.activeAccount).toBe(1);
  });

  it('computes the next revealable index from the highest revealed one', () => {
    expect(nextAccountIndex(parseState(VALID_STATE))).toBe(1);
    expect(
      nextAccountIndex(parseState({ ...VALID_STATE, accounts: [0, 1, 4] })),
    ).toBe(5);
  });
});
