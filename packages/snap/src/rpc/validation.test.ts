import { describe, expect, it } from '@jest/globals';
import { SnapError } from '@metamask/snaps-sdk';

import { OptionalAddressParams, validate } from './validation';

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
