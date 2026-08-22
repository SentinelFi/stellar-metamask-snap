import { describe, expect, it } from '@jest/globals';
import { SnapError } from '@metamask/snaps-sdk';
import type { Struct } from '@metamask/superstruct';

import {
  AddTokenParams,
  MAX_ADDRESS_LENGTH,
  MAX_AUTH_ENTRY_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_NETWORK_PASSPHRASE_LENGTH,
  MAX_XDR_LENGTH,
  OptionalAddressParams,
  SetActiveAccountParams,
  SetNetworkParams,
  SignAuthEntryParams,
  SignMessageParams,
  SignTransactionParams,
  validate,
} from './validation';

const ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

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

  it('bounds address-shaped fields structurally, before the strkey decoder', () => {
    // Regression: `StellarAddress` and `SorobanContractAddress` were
    // `refine(string(), ...)` with no `size()`. The refinement rejected an
    // oversized value, so the bound described what survived validation, but
    // not what validation processed: the whole string was materialized and
    // handed to `StrKey` first. Every other dapp-controlled string in this
    // module carries an explicit cap, and these are reachable on six methods.
    const overlong = `G${'A'.repeat(MAX_ADDRESS_LENGTH)}`;
    expect(overlong.length).toBeGreaterThan(MAX_ADDRESS_LENGTH);

    // Asserted one struct at a time rather than in a loop: the params structs
    // have different shapes, so a single array would widen them to a union
    // that no longer type-checks against `validate`.
    expect(() =>
      validate({ address: overlong }, OptionalAddressParams),
    ).toThrow(SnapError);
    expect(() =>
      validate({ xdr: 'AAAA', address: overlong }, SignTransactionParams),
    ).toThrow(SnapError);
    expect(() =>
      validate({ message: 'hello', address: overlong }, SignMessageParams),
    ).toThrow(SnapError);
    expect(() =>
      validate({ authEntry: 'AAAA', address: overlong }, SignAuthEntryParams),
    ).toThrow(SnapError);
    expect(() =>
      validate(
        { contractId: `C${'A'.repeat(MAX_ADDRESS_LENGTH)}` },
        AddTokenParams,
      ),
    ).toThrow(SnapError);
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

  it('bounds the networkPassphrase option', () => {
    // Regression: the passphrase (compared for equality only) was the one
    // string field with no length cap at the RPC boundary.
    const oversized = 'p'.repeat(MAX_NETWORK_PASSPHRASE_LENGTH + 1);
    expect(() =>
      validate(
        { xdr: 'AAAA', networkPassphrase: oversized },
        SignTransactionParams,
      ),
    ).toThrow(SnapError);
    expect(() =>
      validate(
        { authEntry: 'AAAA', networkPassphrase: oversized },
        SignAuthEntryParams,
      ),
    ).toThrow(SnapError);
    expect(() =>
      validate(
        { contractId: CONTRACT_ID, networkPassphrase: oversized },
        AddTokenParams,
      ),
    ).toThrow(SnapError);
    expect(
      validate(
        { xdr: 'AAAA', networkPassphrase: 'Test SDF Network ; September 2015' },
        SignTransactionParams,
      ),
    ).toBeDefined();
  });
});

describe('AddTokenParams', () => {
  it('accepts a valid contract address', () => {
    expect(validate({ contractId: CONTRACT_ID }, AddTokenParams)).toStrictEqual(
      { contractId: CONTRACT_ID },
    );
  });

  it('rejects anything that is not a contract strkey', () => {
    // Regression: contractId was validated as a bare unbounded string at the
    // boundary, with the shape check deferred to the handler.
    const invalid = [
      'not-a-contract',
      '',
      // Account strkey: valid strkey, wrong kind.
      ADDRESS,
      CONTRACT_ID.toLowerCase(),
      CONTRACT_ID.slice(0, 20),
      // Unbounded before: no length cap applied to this field at all.
      `C${'A'.repeat(100_000)}`,
    ];
    for (const contractId of invalid) {
      expect(() => validate({ contractId }, AddTokenParams)).toThrow(SnapError);
    }
  });
});

/**
 * Runs a validation and returns the error it threw, or null.
 *
 * @param params - The params to validate.
 * @param struct - The struct to validate against.
 * @returns The thrown error, or null when validation passed.
 */
function failureOf<Type, Schema>(
  params: unknown,
  struct: Struct<Type, Schema>,
): SnapError | null {
  try {
    validate(params, struct);
    return null;
  } catch (caught) {
    return caught as SnapError;
  }
}

describe('validation error messages', () => {
  it('does not echo the rejected value back', () => {
    // superstruct describes a failure with the received value serialized in
    // full. For a non-object `params` that is the caller's whole payload,
    // unbounded; the message keeps the path and the expectation and drops
    // the value.
    const huge = 'x'.repeat(1024 * 1024);
    const error = failureOf(huge, SignMessageParams);
    expect(error).toBeInstanceOf(SnapError);
    expect(error?.message.length).toBeLessThan(260);
    expect(error?.message).not.toContain('xxxxxxxx');
  });

  it('rejects unknown keys, including a prototype key', () => {
    expect(
      failureOf({ message: 'hi', extra: 1 }, SignMessageParams),
    ).not.toBeNull();
    expect(
      failureOf(
        JSON.parse('{"message":"hi","__proto__":{"polluted":true}}'),
        SignMessageParams,
      ),
    ).not.toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects a non-object params value and a wrongly typed submit flag', () => {
    for (const params of [null, [], 'text', 42]) {
      expect(failureOf(params, SignMessageParams)).not.toBeNull();
    }
    expect(
      failureOf({ xdr: 'AAAA', submit: 'yes' }, SignTransactionParams),
    ).not.toBeNull();
  });
});

describe('SetNetworkParams and SetActiveAccountParams', () => {
  it('accept exactly the documented shapes', () => {
    expect(validate({ network: 'PUBLIC' }, SetNetworkParams)).toStrictEqual({
      network: 'PUBLIC',
    });
    expect(validate({ index: 3 }, SetActiveAccountParams)).toStrictEqual({
      index: 3,
    });
  });

  it('reject unknown networks and out-of-range or non-integer indices', () => {
    expect(failureOf({ network: 'MAINNET' }, SetNetworkParams)).not.toBeNull();
    expect(failureOf({ network: 'public' }, SetNetworkParams)).not.toBeNull();
    for (const index of [-1, 1.5, 256, '1', Number.NaN]) {
      expect(failureOf({ index }, SetActiveAccountParams)).not.toBeNull();
    }
  });
});
