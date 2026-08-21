import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  Address,
  Asset,
  nativeToScVal,
  Networks,
  xdr,
} from '@stellar/stellar-sdk';

import type { SimulationSummary } from './soroban';
import { simulateForDisplay } from './soroban';
import { MAX_PREDIALOG_LOOKUPS, resetRequestLimits } from '../rpc/limiter';

/*
 * The display-verification simulation, driven directly against a mocked RPC.
 *
 * It is reached in production only behind a signing request, an approved
 * dialog, and a live endpoint, which is why it went untested for so long and
 * why testing it here is worth the fixtures: every field it returns is
 * endpoint-controlled, and each one is rendered to a user who is deciding
 * whether to sign. The interesting cases are all failure cases.
 */

const RPC = 'https://soroban-testnet.stellar.org';
const PASSPHRASE = Networks.TESTNET;

/** Official SEP-0005 test vector 1, accounts 0 and 1. */
const ACCOUNT = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const OTHER = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';

const XLM_SAC = Asset.native().contractId(PASSPHRASE);

/** Any envelope will do: the mock never parses it. */
const ENVELOPE = 'AAAAA-not-parsed-by-the-mock';

/**
 * Builds the response surface the RPC client consumes (buffered body, so
 * `readJsonBounded` takes its `arrayBuffer` path).
 *
 * @param body - The JSON body.
 * @returns The mock response.
 */
function mockResponse(body: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer,
  };
}

/**
 * Installs a fetch mock answering with one JSON-RPC result, or throwing.
 *
 * @param result - The `result` member, or an Error to throw instead.
 */
function mockRpc(result: unknown) {
  const mocked = jest.fn(async () => {
    if (result instanceof Error) {
      throw result;
    }
    return mockResponse({ jsonrpc: '2.0', id: 1, result });
  });
  (globalThis as { fetch?: unknown }).fetch = mocked;
}

/**
 * Narrows a summary to its failure arm.
 *
 * Written as a helper rather than an `if` inside a test so the assertions
 * below are unconditional: an `expect` that only runs on one branch passes
 * silently when the other branch is taken, which is the failure mode the
 * lint rule against conditional expectations exists to prevent.
 *
 * @param summary - The summary to narrow.
 * @returns The failure arm.
 * @throws When the simulation succeeded.
 */
function failure(summary: SimulationSummary): { ok: false; error: string } {
  if (summary.ok) {
    throw new Error('Expected the simulation to fail, but it succeeded.');
  }
  return summary;
}

/**
 * Builds a base64 authorization entry with address credentials.
 *
 * @param address - The authorizing account.
 * @returns The base64 XDR.
 */
function authEntry(address: string): string {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: new xdr.Int64(1n),
        signatureExpirationLedger: 1000,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(XLM_SAC).toScAddress(),
            functionName: 'transfer',
            args: [],
          }),
        ),
      subInvocations: [],
    }),
  }).toXDR('base64');
}

/**
 * Builds a base64 SAC transfer event.
 *
 * @param from - The debited account.
 * @param to - The credited account.
 * @param amount - The raw amount.
 * @returns The base64 XDR.
 */
function transferEvent(from: string, to: string, amount: bigint): string {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: new Address(XLM_SAC).toBuffer() as never,
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [
            xdr.ScVal.scvSymbol('transfer'),
            new Address(from).toScVal(),
            new Address(to).toScVal(),
            xdr.ScVal.scvString('native'),
          ],
          data: nativeToScVal(amount, { type: 'i128' }),
        }),
      ),
    }),
  }).toXDR('base64');
}

describe('simulateForDisplay', () => {
  beforeEach(() => {
    resetRequestLimits();
  });

  it('summarizes a successful simulation', async () => {
    mockRpc({
      minResourceFee: '12345',
      latestLedger: 99,
      results: [{ auth: [authEntry(ACCOUNT)] }],
    });

    const summary = await simulateForDisplay(RPC, ENVELOPE);

    expect(summary).toStrictEqual({
      ok: true,
      minResourceFee: '12345',
      authSigners: [ACCOUNT],
      restoreRequired: false,
      latestLedger: 99,
    });
  });

  it('reports a restore requirement and omits an absent ledger', async () => {
    mockRpc({
      minResourceFee: '1',
      restorePreamble: { transactionData: 'AAAA', minResourceFee: '1' },
    });

    const summary = await simulateForDisplay(RPC, ENVELOPE);

    expect(summary).toMatchObject({ ok: true, restoreRequired: true });
    expect(summary).not.toHaveProperty('latestLedger');
  });

  it('reports a missing resource fee as unavailable rather than as zero', async () => {
    // An endpoint that reports no estimate has not said the call is free; a
    // `'0'` default would have rendered exactly that claim.
    mockRpc({});

    expect(await simulateForDisplay(RPC, ENVELOPE)).toMatchObject({
      ok: true,
      minResourceFee: null,
    });
  });

  it('keeps a resource fee at the exact int64 maximum', async () => {
    // The largest fee the protocol can represent; the bound must not eat a
    // legitimate maximal estimate.
    const fee = '9223372036854775807';
    mockRpc({ minResourceFee: fee });

    expect(await simulateForDisplay(RPC, ENVELOPE)).toMatchObject({
      ok: true,
      minResourceFee: fee,
    });
  });

  it('reports a fee of int64 maximum plus one as unavailable', async () => {
    // Still 19 digits, so the digit cap alone admits it, but no int64 fee
    // can ever be this value: a protocol-impossible figure is not an
    // estimate and must not appear as one in a confirmation dialog.
    mockRpc({ minResourceFee: '9223372036854775808' });

    expect(await simulateForDisplay(RPC, ENVELOPE)).toMatchObject({
      ok: true,
      minResourceFee: null,
    });
  });

  it('reports a 19-nines fee as unavailable', async () => {
    // The widest 19-digit value, well above what an int64 can carry.
    mockRpc({ minResourceFee: '9'.repeat(19) });

    expect(await simulateForDisplay(RPC, ENVELOPE)).toMatchObject({
      ok: true,
      minResourceFee: null,
    });
  });

  it('keeps a leading-zero fee whose value is representable', async () => {
    // The bound compares by value, not by digit count: nineteen characters
    // spelling the number one are a perfectly usable estimate.
    const fee = '0000000000000000001';
    mockRpc({ minResourceFee: fee });

    expect(await simulateForDisplay(RPC, ENVELOPE)).toMatchObject({
      ok: true,
      minResourceFee: fee,
    });
  });

  it('reports an oversized resource fee as unavailable, keeping the rest', async () => {
    // The transport cap bounds the response at a megabyte, not the field: a
    // hostile endpoint can still put a near-megabyte digit string here, and
    // BigInt conversion plus rendering it would be the dialog's problem. The
    // fee becomes unavailable; the summary's other data survives.
    mockRpc({
      minResourceFee: '9'.repeat(20),
      latestLedger: 99,
      results: [{ auth: [authEntry(ACCOUNT)] }],
    });

    expect(await simulateForDisplay(RPC, ENVELOPE)).toStrictEqual({
      ok: true,
      minResourceFee: null,
      authSigners: [ACCOUNT],
      restoreRequired: false,
      latestLedger: 99,
    });
  });

  it('deduplicates auth signers across results', async () => {
    mockRpc({
      minResourceFee: '1',
      results: [
        { auth: [authEntry(ACCOUNT), authEntry(ACCOUNT)] },
        { auth: [authEntry(OTHER)] },
      ],
    });

    const summary = await simulateForDisplay(RPC, ENVELOPE);

    expect(summary).toMatchObject({ authSigners: [ACCOUNT, OTHER] });
  });

  it('skips an undecodable auth entry without failing the summary', async () => {
    // The entry stays visible to the user in the raw XDR the dialog shows;
    // what must not happen is the whole simulation being lost to one bad
    // element of an endpoint-controlled array.
    mockRpc({
      minResourceFee: '1',
      results: [{ auth: ['not base64 xdr', authEntry(ACCOUNT)] }],
    });

    expect(await simulateForDisplay(RPC, ENVELOPE)).toMatchObject({
      ok: true,
      authSigners: [ACCOUNT],
    });
  });

  it('surfaces a simulation error as a failed summary', async () => {
    mockRpc({ error: 'HostError: contract call failed' });

    expect(await simulateForDisplay(RPC, ENVELOPE)).toStrictEqual({
      ok: false,
      error: 'HostError: contract call failed',
    });
  });

  it('sanitizes and bounds endpoint-supplied error text', async () => {
    // Endpoint-controlled display text: hidden characters are stripped before
    // it can reach a dialog, and the length is capped so a hostile RPC cannot
    // push the rest of the confirmation off the screen.
    //
    // The cap is a middle truncation (`truncate` keeps its argument on each
    // side of the ellipsis, so 120 means 241 characters at most). That keeps
    // both ends of a long host error legible, which is where the useful part
    // of one usually is.
    mockRpc({ error: `bad‮reversed ${'x'.repeat(400)}` });

    const { error } = failure(await simulateForDisplay(RPC, ENVELOPE));

    expect(error).not.toContain('‮');
    expect(error).toContain('…');
    expect(error.length).toBeLessThanOrEqual(241);
  });

  it('reports an unreachable endpoint instead of throwing', async () => {
    mockRpc(new Error('network down'));

    expect(await simulateForDisplay(RPC, ENVELOPE)).toStrictEqual({
      ok: false,
      error: 'Could not reach the Stellar RPC (simulateTransaction).',
    });
  });

  it('refuses once the global pre-dialog budget is exhausted', async () => {
    mockRpc({ minResourceFee: '1' });
    for (let index = 0; index < MAX_PREDIALOG_LOOKUPS; index++) {
      await simulateForDisplay(RPC, ENVELOPE, { connected: true });
    }

    const { error } = failure(
      await simulateForDisplay(RPC, ENVELOPE, { connected: true }),
    );

    expect(error).toContain('Retry in a minute');
  });

  it('summarizes balance changes when given an account and network', async () => {
    mockRpc({
      minResourceFee: '1',
      events: [transferEvent(ACCOUNT, OTHER, 25000000n)],
    });

    const summary = await simulateForDisplay(RPC, ENVELOPE, {
      account: ACCOUNT,
      networkPassphrase: PASSPHRASE,
    });

    expect(summary).toMatchObject({
      ok: true,
      balanceChanges: {
        changes: [{ asset: 'XLM', amount: '-2.5', rawUnits: false }],
        partial: false,
      },
    });
  });

  it('omits balance changes when there is no account to key them against', async () => {
    // The dialog renders the section only when it is present, so leaving it
    // out is what keeps "not computed" from reading as "nothing moved".
    mockRpc({
      minResourceFee: '1',
      events: [transferEvent(ACCOUNT, OTHER, 25000000n)],
    });

    const summary = await simulateForDisplay(RPC, ENVELOPE, {
      networkPassphrase: PASSPHRASE,
    });

    expect(summary).not.toHaveProperty('balanceChanges');
  });
});
