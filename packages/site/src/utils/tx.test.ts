/* eslint-disable no-restricted-globals */
// Runs under Node: `Buffer` is the SDK's own byte type here.
import { describe, expect, it } from '@jest/globals';
import { StrKey } from '@stellar/stellar-sdk';

import {
  baseAccount,
  isValidDestination,
  MAX_MEMO_BYTES,
  memoByteLength,
  validateAmount,
} from './tx';

const ACCOUNT = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

/** The same account as a muxed address with sub-id 7. */
const MUXED = StrKey.encodeMed25519PublicKey(
  Buffer.concat([
    StrKey.decodeEd25519PublicKey(ACCOUNT),
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 7]),
  ]),
);

describe('isValidDestination', () => {
  it('accepts checksum-valid account and muxed addresses', () => {
    expect(isValidDestination(ACCOUNT)).toBe(true);
    expect(isValidDestination(MUXED)).toBe(true);
  });

  it('refuses anything else, including a corrupted checksum', () => {
    expect(isValidDestination('')).toBe(false);
    expect(isValidDestination('not an address')).toBe(false);
    expect(isValidDestination(`${ACCOUNT.slice(0, -1)}A`)).toBe(false);
    // A contract address is a valid strkey of the wrong kind.
    expect(
      isValidDestination(
        'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      ),
    ).toBe(false);
  });
});

describe('baseAccount', () => {
  it('resolves a muxed address to the account Horizon indexes', () => {
    expect(baseAccount(MUXED)).toBe(ACCOUNT);
    expect(baseAccount(ACCOUNT)).toBe(ACCOUNT);
  });

  it('returns null for values that name no account', () => {
    expect(baseAccount('')).toBeNull();
    expect(baseAccount('GABC')).toBeNull();
  });
});

describe('validateAmount', () => {
  it('accepts positive amounts within seven decimal places', () => {
    expect(validateAmount('1')).toBeNull();
    expect(validateAmount('0.0000001')).toBeNull();
    expect(validateAmount('123456789012345.1234567')).toBeNull();
  });

  it('refuses zero, negatives, exponents, and excess precision', () => {
    expect(validateAmount('0')).not.toBeNull();
    expect(validateAmount('0.0')).not.toBeNull();
    expect(validateAmount('-1')).not.toBeNull();
    expect(validateAmount('1e3')).not.toBeNull();
    expect(validateAmount('1.12345678')).not.toBeNull();
    expect(validateAmount('')).not.toBeNull();
    expect(validateAmount(' 1')).not.toBeNull();
  });
});

describe('memoByteLength', () => {
  it('counts UTF-8 bytes, which is what the protocol limit counts', () => {
    expect(memoByteLength('')).toBe(0);
    expect(memoByteLength('abc')).toBe(3);
    expect(memoByteLength('é')).toBe(2);
    expect(memoByteLength('漢字')).toBe(6);
    // 28 characters of two-byte text is over the limit; the form must
    // measure bytes, not characters.
    expect(memoByteLength('é'.repeat(MAX_MEMO_BYTES))).toBeGreaterThan(
      MAX_MEMO_BYTES,
    );
  });
});
