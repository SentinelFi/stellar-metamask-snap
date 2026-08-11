import { describe, expect, it } from '@jest/globals';

import {
  isContractId,
  MAX_TOKEN_DECIMALS,
  readTokenBalance,
  sanitizeTokenMetadata,
} from './token';
import { NETWORKS } from '../state/networks';

describe('isContractId', () => {
  it('accepts a valid Soroban contract strkey', () => {
    expect(
      isContractId('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'),
    ).toBe(true);
  });

  it('rejects account (G) strkeys and non-contract input', () => {
    expect(
      isContractId('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6'),
    ).toBe(false);
    expect(isContractId('not-a-contract')).toBe(false);
    expect(isContractId('')).toBe(false);
  });

  it('rejects a C-prefixed string of the wrong length', () => {
    expect(isContractId('CDLZFC3SYJYDZT7K67VZ')).toBe(false);
  });

  it('rejects lowercase (strkeys are uppercase base32)', () => {
    expect(
      isContractId('cdlzfc3syjydzt7k67vz75hpjvieuvnixf47zg2fb2rmqqvu2hhgcysc'),
    ).toBe(false);
  });
});

describe('sanitizeTokenMetadata', () => {
  it('accepts ordinary SEP-41 metadata', () => {
    expect(sanitizeTokenMetadata('USDC', 7)).toStrictEqual({
      symbol: 'USDC',
      decimals: 7,
    });
    expect(sanitizeTokenMetadata('X', 0)).toStrictEqual({
      symbol: 'X',
      decimals: 0,
    });
    expect(sanitizeTokenMetadata('yXLM-2', MAX_TOKEN_DECIMALS)).toStrictEqual({
      symbol: 'yXLM-2',
      decimals: MAX_TOKEN_DECIMALS,
    });
  });

  it('rejects non-string or malformed symbols', () => {
    // Regression: a hostile contract's symbol used to pass with only a
    // typeof check — overlong, empty, or control-character symbols could
    // spoof or garble the balance display.
    expect(sanitizeTokenMetadata(42, 7)).toBeNull();
    expect(sanitizeTokenMetadata('', 7)).toBeNull();
    expect(sanitizeTokenMetadata('WAYTOOLONGSYMBOL', 7)).toBeNull();
    expect(sanitizeTokenMetadata('XL M', 7)).toBeNull();
    // U+202E right-to-left override — a display-spoofing control character.
    expect(sanitizeTokenMetadata('XLM\u202E', 7)).toBeNull();
    expect(sanitizeTokenMetadata('XLM\n', 7)).toBeNull();
  });

  it('rejects out-of-range or non-integer decimals', () => {
    // Regression: decimals passed with only a typeof check, so a hostile
    // contract returning 2**31 hung `10n ** BigInt(decimals)` during
    // balance rendering.
    expect(sanitizeTokenMetadata('USDC', MAX_TOKEN_DECIMALS + 1)).toBeNull();
    expect(sanitizeTokenMetadata('USDC', 2 ** 31)).toBeNull();
    expect(sanitizeTokenMetadata('USDC', -1)).toBeNull();
    expect(sanitizeTokenMetadata('USDC', 7.5)).toBeNull();
    expect(sanitizeTokenMetadata('USDC', Number.NaN)).toBeNull();
    expect(sanitizeTokenMetadata('USDC', '7')).toBeNull();
  });
});

describe('readTokenBalance decimals guard', () => {
  const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  const ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

  it('returns null for corrupt decimals without touching the network', async () => {
    // Guard fires before any RPC call, so this resolves immediately even
    // though no simulation endpoint is reachable in tests.
    expect(
      await readTokenBalance(NETWORKS.TESTNET, CONTRACT, ADDRESS, 2 ** 31),
    ).toBeNull();
    expect(
      await readTokenBalance(NETWORKS.TESTNET, CONTRACT, ADDRESS, -1),
    ).toBeNull();
    expect(
      await readTokenBalance(NETWORKS.TESTNET, CONTRACT, ADDRESS, 7.5),
    ).toBeNull();
  });
});
