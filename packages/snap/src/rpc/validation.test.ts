import { describe, expect, it } from '@jest/globals';
import { SnapError } from '@metamask/snaps-sdk';

import {
  MAX_AUTH_ENTRY_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_XDR_LENGTH,
  OptionalAddressParams,
  SignAuthEntryParams,
  SignMessageParams,
  SignTransactionParams,
  validate,
} from './validation';

const ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

describe('OptionalAddressParams', () => {
  it('accepts a valid ed25519 account address', () => {
    expect(validate({ address: ADDRESS }, OptionalAddressParams)).toStrictEqual(
      { address: ADDRESS },
    );
  });

  it('accepts an omitted address', () => {
    expect(validate({}, OptionalAddressParams)).toStrictEqual({});
  });

  it('rejects strings that are not account strkeys', () => {
    // Regression: `address` used to be validated as a bare string and was
    // interpolated into Horizon URL paths, allowing request-path
    // manipulation like `../ledgers?x=`.
    const invalid = [
      '../ledgers?x=',
      'not-an-address',
      '',
      // Contract strkey — valid strkey, wrong kind.
      'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      // Lowercased account strkey.
      ADDRESS.toLowerCase(),
      // Truncated account strkey.
      ADDRESS.slice(0, 20),
    ];
    for (const address of invalid) {
      expect(() => validate({ address }, OptionalAddressParams)).toThrow(
        SnapError,
      );
    }
  });

  it('maps validation failures to SEP-43 invalid request (-3)', () => {
    let caught: unknown;
    try {
      validate({ address: '../ledgers' }, OptionalAddressParams);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SnapError);
    expect((caught as SnapError).data).toStrictEqual({ code: -3 });
  });
});

describe('signing address option', () => {
  it('accepts a valid address and an omitted one', () => {
    expect(
      validate({ xdr: 'AAAA', address: ADDRESS }, SignTransactionParams),
    ).toStrictEqual({ xdr: 'AAAA', address: ADDRESS });
    expect(
      validate({ message: 'hello', address: ADDRESS }, SignMessageParams),
    ).toStrictEqual({ message: 'hello', address: ADDRESS });
    expect(
      validate({ authEntry: 'AAAA', address: ADDRESS }, SignAuthEntryParams),
    ).toStrictEqual({ authEntry: 'AAAA', address: ADDRESS });

    expect(validate({ xdr: 'AAAA' }, SignTransactionParams)).toStrictEqual({
      xdr: 'AAAA',
    });
    expect(validate({ message: 'hello' }, SignMessageParams)).toStrictEqual({
      message: 'hello',
    });
    expect(validate({ authEntry: 'AAAA' }, SignAuthEntryParams)).toStrictEqual({
      authEntry: 'AAAA',
    });
  });

  it('rejects anything that is not an account strkey', () => {
    // Regression: the signing methods validated `address` as a bare unbounded
    // string while `fund`/`getBalances` strkey-validated the same concept.
    // A value that cannot name an account must not reach account resolution.
    const invalid = [
      'not-an-address',
      '',
      ' ',
      ADDRESS.toLowerCase(),
      ADDRESS.slice(0, 20),
      // Contract strkey: valid strkey, wrong kind, and never an account the
      // wallet can sign for.
      'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      // Unbounded before: no length cap applied to this field at all.
      'G'.repeat(100_000),
    ];
    for (const address of invalid) {
      expect(() =>
        validate({ xdr: 'AAAA', address }, SignTransactionParams),
      ).toThrow(SnapError);
      expect(() =>
        validate({ message: 'hello', address }, SignMessageParams),
      ).toThrow(SnapError);
      expect(() =>
        validate({ authEntry: 'AAAA', address }, SignAuthEntryParams),
      ).toThrow(SnapError);
    }
  });
});

describe('payload size bounds', () => {
  it('accepts payloads at the limit', () => {
    expect(
      validate({ xdr: 'A'.repeat(MAX_XDR_LENGTH) }, SignTransactionParams),
    ).toBeDefined();
    expect(
      validate(
        { authEntry: 'A'.repeat(MAX_AUTH_ENTRY_LENGTH) },
        SignAuthEntryParams,
      ),
    ).toBeDefined();
    expect(
      validate({ message: 'm'.repeat(MAX_MESSAGE_LENGTH) }, SignMessageParams),
    ).toBeDefined();
  });

  it('rejects an oversized xdr with -3 before parsing', () => {
    expect(() =>
      validate({ xdr: 'A'.repeat(MAX_XDR_LENGTH + 1) }, SignTransactionParams),
    ).toThrow(SnapError);
  });

  it('rejects an oversized authEntry and message', () => {
    expect(() =>
      validate(
        { authEntry: 'A'.repeat(MAX_AUTH_ENTRY_LENGTH + 1) },
        SignAuthEntryParams,
      ),
    ).toThrow(SnapError);
    expect(() =>
      validate(
        { message: 'm'.repeat(MAX_MESSAGE_LENGTH + 1) },
        SignMessageParams,
      ),
    ).toThrow(SnapError);
  });

  it('rejects an empty required payload', () => {
    expect(() => validate({ xdr: '' }, SignTransactionParams)).toThrow(
      SnapError,
    );
    expect(() => validate({ message: '' }, SignMessageParams)).toThrow(
      SnapError,
    );
  });
});
