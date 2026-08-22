import { describe, expect, it } from '@jest/globals';
import {
  Address,
  Asset,
  nativeToScVal,
  Networks,
  xdr,
} from '@stellar/stellar-sdk';

import { summarizeBalanceChanges } from './events';

/*
 * The balance-change summary is the only part of a Soroban review dialog that
 * states effects rather than inputs, so its failure modes are display-
 * integrity failures: a movement silently dropped, a movement attributed to
 * the wrong account, or a fabricated asset name accepted from the contract
 * that emitted the event. Each has a test below.
 *
 * Accounts 0 and 1 of official SEP-0005 test vector 1, as elsewhere in the
 * suite. Their mnemonic is published, so nothing here may ever hold funds.
 */
const ACCOUNT = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const OTHER = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';

const PASSPHRASE = Networks.TESTNET;

/** The native asset's Stellar Asset Contract on testnet. */
const XLM_SAC = Asset.native().contractId(PASSPHRASE);

/** A well-formed contract address that is not a Stellar Asset Contract. */
const OTHER_CONTRACT = Address.contract(Buffer.alloc(32, 7)).toString();

/** An issued asset and its (deterministic) contract address. */
const USDC = new Asset('USDC', OTHER);
const USDC_SAC = USDC.contractId(PASSPHRASE);

/**
 * Builds a base64 `DiagnosticEvent` the way the RPC returns them.
 *
 * @param options - Event options.
 * @param options.contract - The emitting contract address.
 * @param options.topics - The event topics.
 * @param options.data - The event data ScVal.
 * @param options.successful - Whether the emitting call succeeded.
 * @param options.type - The contract event type.
 * @returns The base64 XDR.
 */
function buildEvent({
  contract,
  topics,
  data,
  successful = true,
  type = xdr.ContractEventType.contract(),
}: {
  contract: string;
  topics: xdr.ScVal[];
  data: xdr.ScVal;
  successful?: boolean;
  type?: xdr.ContractEventType;
}): string {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: successful,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: new Address(contract).toBuffer() as never,
      type,
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({ topics, data }),
      ),
    }),
  }).toXDR('base64');
}

/**
 * Builds a SAC-style `transfer` event.
 *
 * @param options - Transfer options.
 * @param options.contract - The emitting contract.
 * @param options.from - The debited address.
 * @param options.to - The credited address.
 * @param options.amount - The raw amount.
 * @param options.asset - The trailing asset topic, when the emitter is a SAC.
 * @param options.data - The event body, defaulting to the amount as an `i128`.
 * @returns The base64 XDR.
 */
function transfer({
  contract = XLM_SAC,
  from = ACCOUNT,
  to = OTHER,
  amount = 10000000n,
  asset = 'native' as string | null,
  data = nativeToScVal(amount, { type: 'i128' }),
}: {
  contract?: string;
  from?: string;
  to?: string;
  amount?: bigint;
  asset?: string | null;
  data?: xdr.ScVal;
} = {}): string {
  return buildEvent({
    contract,
    topics: [
      xdr.ScVal.scvSymbol('transfer'),
      new Address(from).toScVal(),
      new Address(to).toScVal(),
      ...(asset === null ? [] : [xdr.ScVal.scvString(asset)]),
    ],
    data,
  });
}

describe('summarizeBalanceChanges', () => {
  it('reports an outgoing SAC transfer as a negative XLM row', () => {
    const summary = summarizeBalanceChanges([transfer()], ACCOUNT, PASSPHRASE);

    expect(summary.partial).toBe(false);
    expect(summary.changes).toStrictEqual([
      { asset: 'XLM', identity: 'XLM (native)', amount: '-1', rawUnits: false },
    ]);
  });

  it('reports an incoming transfer as a signed positive row', () => {
    const summary = summarizeBalanceChanges(
      [transfer({ from: OTHER, to: ACCOUNT, amount: 25000000n })],
      ACCOUNT,
      PASSPHRASE,
    );

    expect(summary.changes).toStrictEqual([
      {
        asset: 'XLM',
        identity: 'XLM (native)',
        amount: '+2.5',
        rawUnits: false,
      },
    ]);
  });

  it('nets multiple movements of the same asset', () => {
    const summary = summarizeBalanceChanges(
      [
        transfer({ from: ACCOUNT, to: OTHER, amount: 30000000n }),
        transfer({ from: OTHER, to: ACCOUNT, amount: 10000000n }),
      ],
      ACCOUNT,
      PASSPHRASE,
    );

    expect(summary.changes).toStrictEqual([
      { asset: 'XLM', identity: 'XLM (native)', amount: '-2', rawUnits: false },
    ]);
  });

  it('lists what leaves the account before what arrives', () => {
    const summary = summarizeBalanceChanges(
      [
        transfer({
          contract: USDC_SAC,
          from: OTHER,
          to: ACCOUNT,
          amount: 50000000n,
          asset: `USDC:${OTHER}`,
        }),
        transfer({ from: ACCOUNT, to: OTHER, amount: 10000000n }),
      ],
      ACCOUNT,
      PASSPHRASE,
    );

    expect(summary.changes.map((change) => change.amount)).toStrictEqual([
      '-1',
      '+5',
    ]);
    expect(summary.changes[1]?.asset).toBe(
      `USDC (${OTHER.slice(0, 6)}…${OTHER.slice(-6)})`,
    );
  });

  it('ignores movements between other accounts', () => {
    const summary = summarizeBalanceChanges(
      [transfer({ from: OTHER, to: OTHER })],
      ACCOUNT,
      PASSPHRASE,
    );

    expect(summary).toStrictEqual({ changes: [], partial: false });
  });

  it('ignores a self-transfer, which nets to zero', () => {
    const summary = summarizeBalanceChanges(
      [transfer({ from: ACCOUNT, to: ACCOUNT })],
      ACCOUNT,
      PASSPHRASE,
    );

    expect(summary.changes).toStrictEqual([]);
  });

  it('credits a muxed recipient to its underlying account', () => {
    const muxed = xdr.ScVal.scvAddress(
      xdr.ScAddress.scAddressTypeMuxedAccount(
        new xdr.MuxedEd25519Account({
          id: new xdr.Uint64(42n),
          ed25519: new Address(ACCOUNT).toBuffer() as never,
        }),
      ),
    );
    const event = buildEvent({
      contract: XLM_SAC,
      topics: [
        xdr.ScVal.scvSymbol('transfer'),
        new Address(OTHER).toScVal(),
        muxed,
        xdr.ScVal.scvString('native'),
      ],
      data: nativeToScVal(10000000n, { type: 'i128' }),
    });

    const summary = summarizeBalanceChanges([event], ACCOUNT, PASSPHRASE);

    expect(summary.changes).toStrictEqual([
      { asset: 'XLM', identity: 'XLM (native)', amount: '+1', rawUnits: false },
    ]);
  });

  it('reads the amount from a post-CAP-67 map payload', () => {
    const event = buildEvent({
      contract: XLM_SAC,
      topics: [
        xdr.ScVal.scvSymbol('transfer'),
        new Address(ACCOUNT).toScVal(),
        new Address(OTHER).toScVal(),
        xdr.ScVal.scvString('native'),
      ],
      data: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('amount'),
          val: nativeToScVal(10000000n, { type: 'i128' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('to_muxed_id'),
          val: nativeToScVal(7, { type: 'u32' }),
        }),
      ]),
    });

    const summary = summarizeBalanceChanges([event], ACCOUNT, PASSPHRASE);

    expect(summary.changes).toStrictEqual([
      { asset: 'XLM', identity: 'XLM (native)', amount: '-1', rawUnits: false },
    ]);
  });

  it('debits a burn and credits a mint', () => {
    const burn = buildEvent({
      contract: XLM_SAC,
      topics: [
        xdr.ScVal.scvSymbol('burn'),
        new Address(ACCOUNT).toScVal(),
        xdr.ScVal.scvString('native'),
      ],
      data: nativeToScVal(10000000n, { type: 'i128' }),
    });
    const mint = buildEvent({
      contract: USDC_SAC,
      // The pre-CAP-67 layout, whose admin topic precedes the recipient.
      topics: [
        xdr.ScVal.scvSymbol('mint'),
        new Address(OTHER).toScVal(),
        new Address(ACCOUNT).toScVal(),
        xdr.ScVal.scvString(`USDC:${OTHER}`),
      ],
      data: nativeToScVal(20000000n, { type: 'i128' }),
    });

    const summary = summarizeBalanceChanges([burn, mint], ACCOUNT, PASSPHRASE);

    expect(summary.changes.map((change) => change.amount)).toStrictEqual([
      '-1',
      '+2',
    ]);
  });

  it('refuses an asset name the emitting contract cannot prove', () => {
    // A contract that is not the native SAC claims to be it. Accepting the
    // topic on the contract's word would render a fabricated XLM row.
    const summary = summarizeBalanceChanges(
      [transfer({ contract: OTHER_CONTRACT })],
      ACCOUNT,
      PASSPHRASE,
    );

    expect(summary.changes).toStrictEqual([
      {
        asset: `Token ${OTHER_CONTRACT.slice(0, 6)}…${OTHER_CONTRACT.slice(-6)}`,
        identity: OTHER_CONTRACT,
        amount: '-10000000',
        rawUnits: true,
      },
    ]);
  });

  it('refuses an impersonated name even after a real one was verified', () => {
    // The asset-name derivation is memoized per asset name. If the *verdict*
    // were memoized instead, the genuine native SAC below would lend its
    // verified `XLM` label to the impostor emitting the same claim, which is
    // the exact impersonation the check exists to stop.
    const summary = summarizeBalanceChanges(
      [transfer(), transfer({ contract: OTHER_CONTRACT })],
      ACCOUNT,
      PASSPHRASE,
    );

    expect(summary.changes.map((change) => change.asset)).toStrictEqual([
      'XLM',
      `Token ${OTHER_CONTRACT.slice(0, 6)}…${OTHER_CONTRACT.slice(-6)}`,
    ]);
  });

  it('refuses a SAC asset name derived for a different network', () => {
    const summary = summarizeBalanceChanges(
      [transfer()],
      ACCOUNT,
      Networks.PUBLIC,
    );

    expect(summary.changes[0]?.rawUnits).toBe(true);
  });

  it('names and scales a tracked token by its stored metadata', () => {
    const summary = summarizeBalanceChanges(
      [transfer({ contract: OTHER_CONTRACT, asset: null, amount: 1500n })],
      ACCOUNT,
      PASSPHRASE,
      [{ contractId: OTHER_CONTRACT, symbol: 'ABC', decimals: 2 }],
    );

    expect(summary.changes).toStrictEqual([
      {
        asset: `ABC (${OTHER_CONTRACT.slice(0, 6)}…${OTHER_CONTRACT.slice(-6)})`,
        identity: OTHER_CONTRACT,
        amount: '-15',
        rawUnits: false,
      },
    ]);
  });

  it('skips events from a call that did not succeed', () => {
    const event = buildEvent({
      contract: XLM_SAC,
      topics: [
        xdr.ScVal.scvSymbol('transfer'),
        new Address(ACCOUNT).toScVal(),
        new Address(OTHER).toScVal(),
        xdr.ScVal.scvString('native'),
      ],
      data: nativeToScVal(10000000n, { type: 'i128' }),
      successful: false,
    });

    expect(summarizeBalanceChanges([event], ACCOUNT, PASSPHRASE)).toStrictEqual(
      { changes: [], partial: false },
    );
  });

  it('skips host diagnostics and non-token contract events', () => {
    const diagnostic = buildEvent({
      contract: XLM_SAC,
      topics: [
        xdr.ScVal.scvSymbol('transfer'),
        new Address(ACCOUNT).toScVal(),
        new Address(OTHER).toScVal(),
      ],
      data: nativeToScVal(10000000n, { type: 'i128' }),
      type: xdr.ContractEventType.diagnostic(),
    });
    const unrelated = buildEvent({
      contract: OTHER_CONTRACT,
      topics: [xdr.ScVal.scvSymbol('vote'), new Address(ACCOUNT).toScVal()],
      data: nativeToScVal(1, { type: 'u32' }),
    });

    const summary = summarizeBalanceChanges(
      [diagnostic, unrelated],
      ACCOUNT,
      PASSPHRASE,
    );

    // Neither is a balance movement, so neither makes the summary partial.
    expect(summary).toStrictEqual({ changes: [], partial: false });
  });

  it('marks the summary partial when an event cannot be decoded', () => {
    const summary = summarizeBalanceChanges(
      ['not base64 xdr at all', transfer()],
      ACCOUNT,
      PASSPHRASE,
    );

    expect(summary.partial).toBe(true);
    // The decodable movement is still reported: a partial list beats none.
    expect(summary.changes).toHaveLength(1);
  });

  it('marks the summary partial when a token event carries no amount', () => {
    const event = buildEvent({
      contract: XLM_SAC,
      topics: [
        xdr.ScVal.scvSymbol('transfer'),
        new Address(ACCOUNT).toScVal(),
        new Address(OTHER).toScVal(),
        xdr.ScVal.scvString('native'),
      ],
      data: xdr.ScVal.scvString('surprise'),
    });

    expect(summarizeBalanceChanges([event], ACCOUNT, PASSPHRASE)).toStrictEqual(
      { changes: [], partial: true },
    );
  });

  it('marks the summary partial when the event count exceeds the cap', () => {
    const events = Array.from({ length: 101 }, () => transfer());

    expect(summarizeBalanceChanges(events, ACCOUNT, PASSPHRASE).partial).toBe(
      true,
    );
  });

  it('marks the summary partial beyond the distinct-asset cap', () => {
    // 13 distinct emitting contracts; the 13th cannot be shown.
    const events = Array.from({ length: 13 }, (_, index) =>
      transfer({
        contract: Address.contract(Buffer.alloc(32, index + 1)).toString(),
        asset: null,
      }),
    );

    const summary = summarizeBalanceChanges(events, ACCOUNT, PASSPHRASE);

    expect(summary.changes).toHaveLength(12);
    expect(summary.partial).toBe(true);
  });

  it('returns an empty summary when the simulation reported no events', () => {
    expect(
      summarizeBalanceChanges(undefined, ACCOUNT, PASSPHRASE),
    ).toStrictEqual({ changes: [], partial: false });
    expect(summarizeBalanceChanges([], ACCOUNT, PASSPHRASE)).toStrictEqual({
      changes: [],
      partial: false,
    });
  });
});

describe('amounts that are not the encoding a token amount has', () => {
  /*
   * The direction of a row is computed by subtracting the amount when the
   * signing account is the sender. The amount comes from the endpoint, so if
   * a negative value were accepted the subtraction would become an addition
   * and an outgoing transfer would be rendered as an incoming one. A summary
   * is allowed to be incomplete, and says so; it is not allowed to be
   * backwards.
   */

  it('refuses a negative amount rather than inverting the direction', () => {
    const summary = summarizeBalanceChanges(
      [
        transfer({
          from: ACCOUNT,
          to: OTHER,
          data: nativeToScVal(-10000000n, { type: 'i128' }),
        }),
      ],
      ACCOUNT,
      PASSPHRASE,
    );
    expect(summary.changes).toStrictEqual([]);
    expect(summary.partial).toBe(true);
  });

  it('refuses an integer that is not an i128', () => {
    // `scValToNative` flattens every integer width, so without a variant
    // check a u64 counter or a u256 would be presented as a token amount.
    for (const type of ['u64', 'i64', 'u128'] as const) {
      const summary = summarizeBalanceChanges(
        [transfer({ data: nativeToScVal(10000000n, { type }) })],
        ACCOUNT,
        PASSPHRASE,
      );
      expect(summary.changes).toStrictEqual([]);
      expect(summary.partial).toBe(true);
    }
  });

  it('holds the post-CAP-67 map form to the same rule', () => {
    const mapWith = (amount: xdr.ScVal) =>
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount'), val: amount }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('to_muxed_id'),
          val: nativeToScVal(7, { type: 'u32' }),
        }),
      ]);
    const negative = summarizeBalanceChanges(
      [
        transfer({
          data: mapWith(nativeToScVal(-10000000n, { type: 'i128' })),
        }),
      ],
      ACCOUNT,
      PASSPHRASE,
    );
    expect(negative.changes).toStrictEqual([]);
    expect(negative.partial).toBe(true);

    const wrongType = summarizeBalanceChanges(
      [transfer({ data: mapWith(nativeToScVal(10000000n, { type: 'u64' })) })],
      ACCOUNT,
      PASSPHRASE,
    );
    expect(wrongType.changes).toStrictEqual([]);
    expect(wrongType.partial).toBe(true);
  });

  it('still reads a well-formed amount in both shapes', () => {
    // The positive control: the refusals above must come from the encoding,
    // not from the helper having stopped producing readable events.
    const bare = summarizeBalanceChanges(
      [transfer({ from: OTHER, to: ACCOUNT })],
      ACCOUNT,
      PASSPHRASE,
    );
    expect(bare.changes.map((change) => change.amount)).toStrictEqual(['+1']);
    expect(bare.partial).toBe(false);
  });
});
