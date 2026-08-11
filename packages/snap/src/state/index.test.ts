import { describe, expect, it } from '@jest/globals';

import { isSafeStateKey, originHasGrant, parseState } from '.';

const VALID_STATE = {
  version: 1,
  network: 'TESTNET',
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

const DEFAULT_STATE = {
  version: 1,
  network: 'TESTNET',
  origins: {},
  tokens: {},
};

describe('parseState', () => {
  it('passes valid state through unchanged', () => {
    expect(parseState(VALID_STATE)).toStrictEqual(VALID_STATE);
  });

  it('accepts state without the optional tokens map', () => {
    const withoutTokens = {
      version: 1,
      network: 'TESTNET',
      origins: VALID_STATE.origins,
    };
    expect(parseState(withoutTokens)).toStrictEqual(withoutTokens);
  });

  it('resets to defaults on an unknown version', () => {
    // Regression: stored state used to be cast unchecked, so a downgrade
    // from a future state version would flow into signing/display paths.
    expect(parseState({ ...VALID_STATE, version: 2 })).toStrictEqual(
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
