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
  findUndisplayableAuthEntry,
  formatScVal,
  getSorobanOperation,
  hasMisplacedSorobanOperation,
  MAX_AUTH_TTL_LEDGERS,
  MAX_EMBEDDED_AUTH_ENTRIES,
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
  it('renders symbols, integers, and addresses in typed notation', () => {
    expect(formatScVal(xdr.ScVal.scvSymbol('transfer'))).toBe('sym(transfer)');
    expect(formatScVal(xdr.ScVal.scvU32(7))).toBe('u32(7)');
    expect(formatScVal(new Address(SOURCE).toScVal())).toContain(SOURCE);
  });

  it('keeps values of different types distinguishable', () => {
    // A string "7" and a u32 7 must never render identically.
    expect(formatScVal(xdr.ScVal.scvString('7'))).toBe('str("7")');
    expect(formatScVal(xdr.ScVal.scvU32(7))).toBe('u32(7)');
    // A symbol and a string of the same text differ too.
    expect(formatScVal(xdr.ScVal.scvString('transfer'))).toBe(
      'str("transfer")',
    );
    expect(formatScVal(xdr.ScVal.scvSymbol('transfer'))).toBe('sym(transfer)');
  });

  it('renders bytes as hex and containers with typed elements', () => {
    expect(formatScVal(xdr.ScVal.scvBytes(Buffer.from([0x6a, 0x6f])))).toBe(
      'bytes(6a6f)',
    );
    expect(
      formatScVal(
        xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvSymbol('a')]),
      ),
    ).toBe('[u32(1), sym(a)]');
  });

  it('renders error, nonce-key, and contract-instance payloads faithfully', () => {
    expect(formatScVal(xdr.ScVal.scvError(xdr.ScError.sceContract(5)))).toBe(
      'error(sceContract, 5)',
    );
    expect(
      formatScVal(
        xdr.ScVal.scvError(
          xdr.ScError.sceWasmVm(xdr.ScErrorCode.scecInvalidInput()),
        ),
      ),
    ).toBe('error(sceWasmVm, scecInvalidInput)');
    expect(
      formatScVal(
        xdr.ScVal.scvLedgerKeyNonce(
          new xdr.ScNonceKey({ nonce: new xdr.Int64(42n) }),
        ),
      ),
    ).toBe('ledger-key(nonce(42))');
    expect(
      formatScVal(
        xdr.ScVal.scvContractInstance(
          new xdr.ScContractInstance({
            executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
            storage: null,
          }),
        ),
      ),
    ).toBe('contract-instance(built-in-token)');
  });

  it('flags an unknown future ScVal variant as not fully rendered', () => {
    const future = {
      switch: () => ({ name: 'scvFuture' }),
    } as unknown as xdr.ScVal;
    const flags = { truncated: false };
    expect(formatScVal(future, 0, flags)).toBe('unsupported(scvFuture)');
    expect(flags.truncated).toBe(true);
  });

  it('tags the raw-XDR fallback and reports it like truncation', () => {
    // A value that parses structurally but throws during rendering must not
    // display as bare base64 (which could imitate a strkey address).
    const broken = {
      switch: () => {
        throw new Error('unrenderable');
      },
      toXDR: () => 'AAAA',
    } as unknown as xdr.ScVal;
    const flags = { truncated: false };
    expect(formatScVal(broken, 0, flags)).toBe('xdr(AAAA)');
    expect(flags.truncated).toBe(true);
  });

  it('stringifies BigInt-valued i128 without throwing', () => {
    const big = xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: new xdr.Int64(0n),
        lo: new xdr.Uint64(10000000n),
      }),
    );
    expect(formatScVal(big)).toBe('i128(10000000)');
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
    expect(decoded.args[1]).toBe('u32(5)');
  });

  it('reports truncation when invoke arguments exceed the render cap', () => {
    const tx = txWith(
      Operation.invokeContractFunction({
        contract: CONTRACT,
        function: 'transfer',
        args: Array.from({ length: 25 }, (_, index) => xdr.ScVal.scvU32(index)),
      }),
    );
    const op = getSorobanOperation(tx) as { func: xdr.HostFunction };
    expect(decodeHostFunction(op.func).truncated).toBe(true);
  });

  it('reports a fully rendered invocation as not truncated', () => {
    const tx = txWith(
      Operation.invokeContractFunction({
        contract: CONTRACT,
        function: 'transfer',
        args: [xdr.ScVal.scvU32(1)],
      }),
    );
    const op = getSorobanOperation(tx) as { func: xdr.HostFunction };
    expect(decodeHostFunction(op.func).truncated).toBe(false);
  });

  it('decodes create-contract parameters for review', () => {
    const createArgs = new xdr.CreateContractArgs({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(SOURCE).toScAddress(),
          salt: Buffer.alloc(32, 7),
        }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(
        Buffer.alloc(32, 9),
      ),
    });
    const decoded = decodeHostFunction(
      xdr.HostFunction.hostFunctionTypeCreateContract(createArgs),
    );
    expect(decoded.kind).toBe('createContract');
    const details = JSON.stringify(decoded.details);
    expect(details).toContain(SOURCE);
    expect(details).toContain(Buffer.alloc(32, 7).toString('hex'));
    expect(details).toContain(Buffer.alloc(32, 9).toString('hex'));
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
    // Truncation is reported so signing paths can fail closed.
    expect(decoded.truncated).toBe(true);
  });

  it('reports truncation for an invocation with too many arguments', () => {
    const args = Array.from({ length: 25 }, (_, i) => xdr.ScVal.scvU32(i));
    const node = new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(CONTRACT).toScAddress(),
            functionName: 'transfer',
            args,
          }),
        ),
      subInvocations: [],
    });
    const decoded = decodeAuthEntry(addressEntry(node));
    expect(decoded.truncated).toBe(true);
  });

  it('reports truncation for an oversized bytes argument', () => {
    const node = new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(CONTRACT).toScAddress(),
            functionName: 'transfer',
            args: [xdr.ScVal.scvBytes(Buffer.alloc(100, 1))],
          }),
        ),
      subInvocations: [],
    });
    const decoded = decodeAuthEntry(addressEntry(node));
    expect(decoded.truncated).toBe(true);
  });

  it('does not report truncation for a small, fully rendered entry', () => {
    const decoded = decodeAuthEntry(addressEntry(invocation([], 'transfer')));
    expect(decoded.truncated).toBe(false);
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

  it('shows the full authorizing address, not a shortened form', () => {
    const summaries = summarizeAuthEntries([
      addressEntry(invocation([], 'transfer')),
    ]);
    expect(summaries[0]).toContain(SOURCE);
    expect(summaries[0]).toContain(CONTRACT);
  });

  it('marks entries beyond the render cap instead of dropping them silently', () => {
    const entries = Array.from({ length: 25 }, () =>
      addressEntry(invocation([], 'transfer')),
    );
    const summaries = summarizeAuthEntries(entries);
    expect(summaries).toHaveLength(21);
    expect(summaries[20]).toContain('5 more entries not shown');
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

  it('fails closed on a nonzero expiry when the ledger is unknown', () => {
    // Without the current ledger the maximum-lifetime bound cannot be
    // enforced, so the expiry must not pass through unverified.
    expect(boundAuthExpiration(NOW + 500, null)).toStrictEqual({
      ok: false,
      reason: 'noLedger',
    });
  });

  it('cannot resolve an unset expiry without the current ledger', () => {
    expect(boundAuthExpiration(0, null)).toStrictEqual({
      ok: false,
      reason: 'noLedger',
    });
  });
});

describe('formatScVal (hidden characters)', () => {
  it('escapes bidi overrides in strings so display order cannot flip', () => {
    const rendered = formatScVal(xdr.ScVal.scvString('pay\u202E100 to A'));
    expect(rendered).not.toContain('\u202E');
    expect(rendered).toContain('\\u{202e}');
  });

  it('escapes zero-width characters in quoted symbols', () => {
    const rendered = formatScVal(xdr.ScVal.scvSymbol('tra\u200Bnsfer!'));
    expect(rendered).not.toContain('\u200B');
    expect(rendered).toContain('\\u{200b}');
  });

  it('leaves clean strings untouched', () => {
    expect(formatScVal(xdr.ScVal.scvString('hello'))).toBe('str("hello")');
  });
});

describe('hasMisplacedSorobanOperation', () => {
  it('flags a Soroban operation mixed into a multi-op transaction', () => {
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
    expect(hasMisplacedSorobanOperation(tx)).toBe(true);
  });

  it('accepts a lone Soroban operation', () => {
    const tx = txWith(
      Operation.invokeContractFunction({
        contract: CONTRACT,
        function: 'transfer',
        args: [],
      }),
    );
    expect(hasMisplacedSorobanOperation(tx)).toBe(false);
  });

  it('accepts a classic multi-op transaction', () => {
    const tx = new TransactionBuilder(new Account(SOURCE, '1'), {
      fee: '200',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .addOperation(
        Operation.payment({
          destination: SOURCE,
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build();
    expect(hasMisplacedSorobanOperation(tx)).toBe(false);
  });
});

describe('findUndisplayableAuthEntry', () => {
  /**
   * Builds a fake auth entry whose accessors report the given credential
   * discriminant. Real XDR cannot carry unknown union arms (the SDK refuses
   * to parse them), so future-variant behavior is exercised structurally.
   *
   * @param credentialName - The credential switch name to report.
   * @param functionName - The invocation function switch name to report.
   * @returns An object shaped like an auth entry.
   */
  function fakeEntry(
    credentialName: string,
    functionName = 'sorobanAuthorizedFunctionTypeContractFn',
  ): xdr.SorobanAuthorizationEntry {
    const fakeInvocation = {
      function: () => ({
        switch: () => ({ name: functionName }),
        contractFn: () => {
          throw new Error('not a real contract fn');
        },
      }),
      subInvocations: () => [],
    };
    return {
      credentials: () => ({
        switch: () => ({ name: credentialName }),
      }),
      rootInvocation: () => fakeInvocation,
    } as unknown as xdr.SorobanAuthorizationEntry;
  }

  it('accepts a well-formed address-credential entry', () => {
    expect(
      findUndisplayableAuthEntry([addressEntry(invocation([], 'transfer'))]),
    ).toBeNull();
  });

  it('accepts a source-account entry (authorized by the envelope)', () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: invocation([], 'transfer'),
    });
    expect(findUndisplayableAuthEntry([entry])).toBeNull();
  });

  it('flags an unknown credential variant as unsupported', () => {
    expect(
      findUndisplayableAuthEntry([
        fakeEntry('sorobanCredentialsSomeFutureVariant', 'unknownFn'),
      ]),
    ).toBe('unsupported');
  });

  it('flags an unknown authorized-function variant as unsupported', () => {
    expect(
      findUndisplayableAuthEntry([
        fakeEntry('sorobanCredentialsSourceAccount', 'someFutureFunctionType'),
      ]),
    ).toBe('unsupported');
  });

  it('flags a deeply nested entry as truncated (fail closed)', () => {
    let node = invocation();
    for (let i = 0; i < MAX_INVOCATION_DEPTH + 5; i++) {
      node = invocation([node]);
    }
    expect(findUndisplayableAuthEntry([addressEntry(node)])).toBe('truncated');
  });

  it('flags more entries than the render cap as truncated (fail closed)', () => {
    const entries = Array.from({ length: MAX_EMBEDDED_AUTH_ENTRIES + 1 }, () =>
      addressEntry(invocation([], 'transfer')),
    );
    expect(findUndisplayableAuthEntry(entries)).toBe('truncated');
  });

  it('flags an entry that throws during decode as undecodable', () => {
    const broken = {
      credentials: () => {
        throw new Error('mangled');
      },
      rootInvocation: () => {
        throw new Error('mangled');
      },
    } as unknown as xdr.SorobanAuthorizationEntry;
    expect(findUndisplayableAuthEntry([broken])).toBe('undecodable');
  });

  it('returns null for an empty entry list', () => {
    expect(findUndisplayableAuthEntry([])).toBeNull();
  });
});
