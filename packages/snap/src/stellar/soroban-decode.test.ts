import { describe, expect, it } from '@jest/globals';
import {
  Account,
  Address,
  Asset,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

import {
  boundAuthExpiration,
  decodeAuthEntry,
  decodeHostFunction,
  DEFAULT_AUTH_TTL_LEDGERS,
  formatScVal,
  getSorobanOperation,
  MAX_AUTH_TTL_LEDGERS,
  MAX_INVOCATION_DEPTH,
  summarizeAuthEntries,
} from './soroban';

const SOURCE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/**
 * Builds a contract-fn invocation node with the given sub-invocations.
 *
 * @param subInvocations - Nested invocation nodes.
 * @param fn - The contract function name.
 * @returns The invocation node.
 */
function invocation(
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
  fn = 'transfer',
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(CONTRACT).toScAddress(),
          functionName: fn,
          args: [],
        }),
      ),
    subInvocations,
  });
}

/**
 * Builds an address-credential auth entry wrapping a root invocation.
 *
 * @param root - The root invocation.
 * @returns The auth entry.
 */
function addressEntry(
  root: xdr.SorobanAuthorizedInvocation,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(SOURCE).toScAddress(),
        nonce: new xdr.Int64(1n),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: root,
  });
}

/**
 * Builds a single-operation transaction from the given operation.
 *
 * @param operation - The operation XDR object.
 * @returns The built transaction.
 */
function txWith(operation: xdr.Operation) {
  return new TransactionBuilder(new Account(SOURCE, '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();
}

describe('formatScVal', () => {
  it('renders symbols, integers, and addresses', () => {
    expect(formatScVal(xdr.ScVal.scvSymbol('transfer'))).toBe('"transfer"');
    expect(formatScVal(xdr.ScVal.scvU32(7))).toBe('7');
    expect(formatScVal(new Address(SOURCE).toScVal())).toContain(SOURCE);
  });

  it('stringifies BigInt-valued i128 without throwing', () => {
    const big = xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: new xdr.Int64(0n),
        lo: new xdr.Uint64(10000000n),
      }),
    );
    // i128 decodes to a bigint; the replacer renders it as a JSON string.
    expect(formatScVal(big)).toBe('"10000000"');
  });
});

describe('getSorobanOperation', () => {
  it('returns the operation for a single-op contract invocation', () => {
    const tx = txWith(
      Operation.invokeContractFunction({
        contract: CONTRACT,
        function: 'transfer',
        args: [],
      }),
    );
    expect(getSorobanOperation(tx)?.type).toBe('invokeHostFunction');
  });

  it('returns null for a classic payment', () => {
    const tx = txWith(
      Operation.payment({
        destination: SOURCE,
        asset: Asset.native(),
        amount: '1',
      }),
    );
    expect(getSorobanOperation(tx)).toBeNull();
  });

  it('returns null for a multi-operation transaction', () => {
    const tx = new TransactionBuilder(new Account(SOURCE, '1'), {
      fee: '200',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .addOperation(
        Operation.invokeContractFunction({
          contract: CONTRACT,
          function: 'transfer',
          args: [],
        }),
      )
      .setTimeout(30)
      .build();
    expect(getSorobanOperation(tx)).toBeNull();
  });
});

describe('decodeHostFunction', () => {
  it('decodes a contract invocation', () => {
    const tx = txWith(
      Operation.invokeContractFunction({
        contract: CONTRACT,
        function: 'transfer',
        args: [new Address(SOURCE).toScVal(), xdr.ScVal.scvU32(5)],
      }),
    );
    const op = getSorobanOperation(tx) as { func: xdr.HostFunction };
    const decoded = decodeHostFunction(op.func);
    expect(decoded.kind).toBe('invoke');
    expect(decoded.contract).toBe(CONTRACT);
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toHaveLength(2);
    expect(decoded.args[1]).toBe('5');
  });
});

describe('decodeAuthEntry', () => {
  it('decodes source-account credentials', () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function:
          xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: new Address(CONTRACT).toScAddress(),
              functionName: 'transfer',
              args: [],
            }),
          ),
        subInvocations: [],
      }),
    });
    const decoded = decodeAuthEntry(entry);
    expect(decoded.credentialsType).toBe('sourceAccount');
    expect(decoded.invocations[0]).toContain('transfer');
  });

  it('decodes address credentials with nonce and expiration', () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(SOURCE).toScAddress(),
          nonce: new xdr.Int64(987654n),
          signatureExpirationLedger: 424242,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function:
          xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: new Address(CONTRACT).toScAddress(),
              functionName: 'approve',
              args: [],
            }),
          ),
        subInvocations: [],
      }),
    });
    const decoded = decodeAuthEntry(entry);
    expect(decoded.credentialsType).toBe('address');
    expect(decoded.address).toBe(SOURCE);
    expect(decoded.nonce).toBe('987654');
    expect(decoded.signatureExpirationLedger).toBe(424242);
    expect(decoded.invocations[0]).toContain('approve');
  });

  it('truncates a deeply nested invocation tree', () => {
    // Build a chain deeper than the depth cap.
    let node = invocation();
    for (let i = 0; i < MAX_INVOCATION_DEPTH + 5; i++) {
      node = invocation([node]);
    }
    const decoded = decodeAuthEntry(addressEntry(node));
    // Bounded output, ending in a truncation marker rather than recursing fully.
    expect(decoded.invocations.length).toBeLessThanOrEqual(
      MAX_INVOCATION_DEPTH + 1,
    );
    expect(decoded.invocations.join('\n')).toContain('truncated');
  });
});

describe('summarizeAuthEntries', () => {
  it('renders credential and invocation per entry', () => {
    const summaries = summarizeAuthEntries([
      addressEntry(invocation([], 'transfer')),
      addressEntry(invocation([], 'approve')),
    ]);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain('#1');
    expect(summaries[0]).toContain('transfer');
    expect(summaries[1]).toContain('approve');
  });

  it('flags an undecodable entry instead of throwing', () => {
    const broken = {
      credentials: () => {
        throw new Error('boom');
      },
      rootInvocation: () => invocation(),
    } as unknown as xdr.SorobanAuthorizationEntry;
    const summaries = summarizeAuthEntries([broken]);
    expect(summaries[0]).toContain('undecodable');
  });
});

describe('boundAuthExpiration', () => {
  const NOW = 1_000_000;

  it('defaults an unset (0) expiry to the current ledger + TTL', () => {
    expect(boundAuthExpiration(0, NOW)).toStrictEqual({
      ok: true,
      validUntil: NOW + DEFAULT_AUTH_TTL_LEDGERS,
      ledgersRemaining: DEFAULT_AUTH_TTL_LEDGERS,
    });
  });

  it('accepts a near-future expiry and reports the remaining lifetime', () => {
    expect(boundAuthExpiration(NOW + 500, NOW)).toStrictEqual({
      ok: true,
      validUntil: NOW + 500,
      ledgersRemaining: 500,
    });
  });

  it('rejects an already-expired entry', () => {
    expect(boundAuthExpiration(NOW - 1, NOW)).toStrictEqual({
      ok: false,
      reason: 'expired',
    });
    expect(boundAuthExpiration(NOW, NOW)).toStrictEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects an expiry beyond the maximum lifetime', () => {
    expect(
      boundAuthExpiration(NOW + MAX_AUTH_TTL_LEDGERS + 1, NOW),
    ).toStrictEqual({ ok: false, reason: 'tooLong' });
  });

  it('passes a nonzero expiry through unverified when the ledger is unknown', () => {
    expect(boundAuthExpiration(NOW + 500, null)).toStrictEqual({
      ok: true,
      validUntil: NOW + 500,
      ledgersRemaining: null,
    });
  });

  it('cannot resolve an unset expiry without the current ledger', () => {
    expect(boundAuthExpiration(0, null)).toStrictEqual({
      ok: false,
      reason: 'noLedger',
    });
  });
});
