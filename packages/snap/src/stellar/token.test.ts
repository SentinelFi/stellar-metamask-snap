import { describe, expect, it } from '@jest/globals';

import {
  formatTokenAmount,
  isContractId,
  MAX_TOKEN_DECIMALS,
  readTokenBalance,
  sanitizeTokenMetadata,
} from './token';
import { NETWORKS } from '../state/networks';

/** A real Soroban contract address (checksum valid). */
const VALID_CONTRACT =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/**
 * The same address with one payload character changed, so it keeps the strkey
 * shape and length but fails the CRC16 checksum. Built at module scope rather
 * than inside the test, since the fixture is data, not test logic.
 */
const CORRUPTED_CONTRACT = `${VALID_CONTRACT.slice(0, 10)}A${VALID_CONTRACT.slice(11)}`;

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

  it('rejects a shape-valid strkey whose checksum is wrong', () => {
    // Regression: this was a `/^C[A-Z2-7]{55}$/` shape test, which accepts a
    // mistyped or truncated-and-repadded ID. Such a value then reached two
    // metadata simulations that could only fail, spending addToken rate-limit
    // slots and surfacing "the network may be unreachable" for what is really
    // malformed input. Every other address in the snap is checksum-validated
    // via StrKey; contract IDs now hold to the same standard.
    expect(isContractId(VALID_CONTRACT)).toBe(true);
    // Same length, same alphabet, one payload character different: the shape
    // test cannot tell these apart, the checksum can.
    expect(CORRUPTED_CONTRACT).toHaveLength(VALID_CONTRACT.length);
    expect(/^C[A-Z2-7]{55}$/u.test(CORRUPTED_CONTRACT)).toBe(true);
    expect(isContractId(CORRUPTED_CONTRACT)).toBe(false);
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

describe('formatTokenAmount', () => {
  it('renders ordinary amounts at the token precision', () => {
    expect(formatTokenAmount(15n, 1)).toBe('1.5');
    expect(formatTokenAmount(0n, 7)).toBe('0');
    expect(formatTokenAmount(10000000n, 7)).toBe('1');
    expect(formatTokenAmount(12345000n, 7)).toBe('1.2345');
    expect(formatTokenAmount(5n, 1)).toBe('0.5');
    // decimals 0 is the whole-unit token case.
    expect(formatTokenAmount(42n, 0)).toBe('42');
  });

  it('renders negative amounts without a sign in the fraction', () => {
    // Regression: BigInt `/` and `%` both truncate toward zero, so the
    // remainder kept the sign and `-15n` at 1 decimal rendered as `-1.-5`.
    // The value is contract-reported, so a hostile token can pick it.
    expect(formatTokenAmount(-15n, 1)).toBe('-1.5');
    expect(formatTokenAmount(-12345000n, 7)).toBe('-1.2345');
    expect(formatTokenAmount(-10000000n, 7)).toBe('-1');
    expect(formatTokenAmount(-42n, 0)).toBe('-42');
  });

  it('keeps the sign when the magnitude is below one whole unit', () => {
    // The whole part is 0n here, and `-0n` stringifies as '0', so applying
    // the sign to the number rather than the rendered string would silently
    // turn a negative balance into a positive one.
    expect(formatTokenAmount(-5n, 1)).toBe('-0.5');
    expect(formatTokenAmount(-1n, 7)).toBe('-0.0000001');
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
