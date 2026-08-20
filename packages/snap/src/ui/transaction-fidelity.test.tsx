import { describe, expect, it } from '@jest/globals';
import type { Transaction } from '@stellar/stellar-sdk';
import {
  Account,
  Address,
  Asset,
  Claimant,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

import {
  buildSignTransactionDialog,
  findUndisplayableOperation,
} from './transaction';

/*
 * Fidelity tests for the transaction review dialog: the places where the
 * rendered text could diverge from the signed bytes, or where a consequential
 * value was shown without its meaning. Each describe block below is a
 * regression test for one such gap. The disclosure suite next door covers the
 * presence of rows; this one covers their truthfulness.
 */

/*
 * Accounts 0 and 1 of official SEP-0005 test vector 1, shared with the other
 * suites so a reader recognises them on sight. Nothing here derives or signs
 * with them.
 */
const SOURCE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const DESTINATION = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const ORIGIN = 'https://dapp.example';
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const SOURCE_MISMATCH_TITLE = `Not the signing account's transaction`;

/**
 * Builds a transaction from the given operations (and optional memo) and
 * round-trips it through XDR, so the dialog sees exactly what the SDK
 * decodes from an envelope rather than the builder's in-memory objects.
 *
 * @param operations - The operations to include.
 * @param options - Builder options.
 * @param options.memo - A memo to attach.
 * @param options.sequence - The account sequence; `'-1'` yields sequence 0.
 * @param options.timeout - The `setTimeout` argument.
 * @returns The decoded transaction.
 */
function buildTx(
  operations: xdr.Operation[],
  options: { memo?: Memo; sequence?: string; timeout?: number } = {},
): Transaction {
  const { memo, sequence = '1', timeout = 300 } = options;
  const builder = new TransactionBuilder(new Account(SOURCE, sequence), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  for (const operation of operations) {
    builder.addOperation(operation);
  }
  if (memo) {
    builder.addMemo(memo);
  }
  const built = builder.setTimeout(timeout).build();
  return TransactionBuilder.fromXDR(
    built.toXDR(),
    Networks.TESTNET,
  ) as Transaction;
}

/** A plain native payment, the simplest executable operation. */
const PAYMENT = Operation.payment({
  destination: DESTINATION,
  asset: Asset.native(),
  amount: '1',
});

/**
 * Rewrites one operation of a built envelope at the raw XDR level and decodes
 * the result, for fields the SDK builder cannot produce (non-ASCII bytes in
 * ASCII-decoded fields).
 *
 * @param tx - The transaction to rewrite.
 * @param index - The operation to replace.
 * @param rewrite - Receives the raw operation body and returns the new one.
 * @returns The decoded, rewritten transaction.
 */
function rewriteOperation(
  tx: Transaction,
  index: number,
  rewrite: (body: xdr.OperationBody) => xdr.OperationBody,
): Transaction {
  const envelope = tx.toEnvelope();
  const raw = envelope.v1().tx().operations()[index];
  if (!raw) {
    throw new Error('no such operation');
  }
  raw.body(rewrite(raw.body()));
  return TransactionBuilder.fromXDR(
    envelope.toXDR('base64'),
    Networks.TESTNET,
  ) as Transaction;
}

/**
 * Renders a dialog to its JSON form for structural assertions.
 *
 * @param overrides - Dialog parameter overrides (`tx` is required).
 * @returns The serialized dialog.
 */
function render(
  overrides: Partial<Parameters<typeof buildSignTransactionDialog>[0]> & {
    tx: Parameters<typeof buildSignTransactionDialog>[0]['tx'];
  },
): string {
  return JSON.stringify(
    buildSignTransactionDialog({
      origin: ORIGIN,
      network: 'TESTNET',
      xdr: overrides.tx.toXDR(),
      signingAddress: SOURCE,
      accountIndex: 0,
      ...overrides,
    }),
  );
}

describe('changeTrust removal', () => {
  it('recognises a zero limit as trustline removal', () => {
    // Regression: the removal branch compared the decoded limit with the
    // literal '0', but the SDK decodes a zero limit as '0.0000000', so the
    // branch never ran on a real envelope and removal rendered as an
    // ordinary "Change trustline" with a default-variant zero row.
    const tx = buildTx([
      Operation.changeTrust({
        asset: new Asset('USD', DESTINATION),
        limit: '0',
      }),
    ]);
    expect(tx.operations[0]).toMatchObject({ limit: '0.0000000' });
    const content = render({ tx });
    expect(content).toContain('Remove trustline');
    expect(content).toContain('Remove (0)');
  });

  it('does not call a non-zero limit a removal', () => {
    const tx = buildTx([
      Operation.changeTrust({
        asset: new Asset('USD', DESTINATION),
        limit: '1000',
      }),
    ]);
    const content = render({ tx });
    expect(content).toContain('Change trustline');
    expect(content).not.toContain('Remove trustline');
  });
});

describe('raw-byte rendering of ASCII-decoded fields', () => {
  it('renders a manageData key from its signed bytes, not the masked decode', () => {
    // Regression: the SDK decodes `dataName` with an ASCII decoder that
    // drops bit 7, so the bytes e3 ef ee e6 e9 e7 decoded to the clean word
    // "config" and the dialog showed text that was not the signed key.
    const tx = buildTx([Operation.manageData({ name: 'config', value: 'x' })]);
    const masked = Buffer.from([0xe3, 0xef, 0xee, 0xe6, 0xe9, 0xe7]);
    const rewritten = rewriteOperation(tx, 0, (body) =>
      xdr.OperationBody.manageData(
        new xdr.ManageDataOp({
          dataName: masked,
          dataValue: body.manageDataOp().dataValue(),
        }),
      ),
    );
    // The SDK itself still reads it as "config"; the dialog must not.
    expect(rewritten.operations[0]).toMatchObject({ name: 'config' });
    const content = render({ tx: rewritten });
    expect(content).toContain(`hex:${masked.toString('hex')}`);
    expect(content).toContain('Key is not plain text');
    expect(content).not.toContain('"value":"config"');
  });

  it('still renders a clean manageData key as text', () => {
    const tx = buildTx([Operation.manageData({ name: 'config', value: 'x' })]);
    const content = render({ tx });
    expect(content).toContain('"value":"config"');
    expect(content).not.toContain('Key is not plain text');
  });

  it('renders a home domain from its signed bytes, not the masked decode', () => {
    const tx = buildTx([Operation.setOptions({ homeDomain: 'good.com' })]);
    const masked = Buffer.from([
      0xe7, 0x6f, 0x6f, 0x64, 0x2e, 0x63, 0x6f, 0x6d,
    ]);
    const rewritten = rewriteOperation(tx, 0, (body) => {
      const options = body.setOptionsOp();
      options.homeDomain(masked);
      return xdr.OperationBody.setOptions(options);
    });
    expect(rewritten.operations[0]).toMatchObject({ homeDomain: 'good.com' });
    const content = render({ tx: rewritten });
    expect(content).toContain(`hex:${masked.toString('hex')}`);
    expect(content).toContain('Home domain is not plain text');
    expect(content).not.toContain('good.com');
  });

  it('still renders a clean home domain inline', () => {
    const tx = buildTx([Operation.setOptions({ homeDomain: 'good.com' })]);
    const content = render({ tx });
    expect(content).toContain('good.com');
    expect(content).not.toContain('Home domain is not plain text');
  });
});

describe('memo byte fidelity', () => {
  it('shows the exact bytes of a text memo that is not valid UTF-8', () => {
    // Regression: the decoded memo mapped invalid sequences to U+FFFD, so
    // distinct byte strings rendered identically and no exact copy was
    // offered; U+FFFD is not a hidden character, so no banner fired either.
    const bytes = Buffer.from([0x61, 0xff, 0x62]);
    // The typings say string, but the runtime accepts a Buffer, which is the
    // only way to produce an invalid-UTF-8 memo.
    const tx = buildTx([PAYMENT], { memo: Memo.text(bytes as never) });
    const content = render({ tx });
    expect(content).toContain('Memo (exact bytes)');
    expect(content).toContain(`hex:${bytes.toString('hex')}`);
    expect(content).toContain('Display differs from signed text');
  });

  it('renders a clean text memo inline without a caveat', () => {
    const tx = buildTx([PAYMENT], { memo: Memo.text('invoice 42') });
    const content = render({ tx });
    expect(content).toContain('invoice 42');
    expect(content).not.toContain('Memo (exact bytes)');
    expect(content).not.toContain('Display differs from signed text');
  });

  it('offers an escaped exact copy for a memo with hidden characters', () => {
    const tx = buildTx([PAYMENT], { memo: Memo.text('pay​1') });
    const content = render({ tx });
    expect(content).toContain('Display differs from signed text');
    // Hidden characters make the bytes "not clean", so the exact form is hex.
    expect(content).toContain('Memo (exact bytes)');
  });
});

describe('setOptions outcomes', () => {
  it('names signer removal and master-key disabling instead of bare zeros', () => {
    const tx = buildTx([
      Operation.setOptions({
        masterWeight: 0,
        signer: { ed25519PublicKey: DESTINATION, weight: 0 },
      }),
    ]);
    const content = render({ tx });
    expect(content).toContain('0 (removes this signer)');
    expect(content).toContain('0 (disables the master key)');
    expect(content).toContain('Master key will be disabled');
  });

  it('shows a non-zero weight as a plain number', () => {
    const tx = buildTx([
      Operation.setOptions({
        masterWeight: 2,
        signer: { ed25519PublicKey: DESTINATION, weight: 1 },
      }),
    ]);
    const content = render({ tx });
    expect(content).not.toContain('removes this signer');
    expect(content).not.toContain('disables the master key');
  });

  it('decodes account flags by name and marks AUTH_IMMUTABLE irreversible', () => {
    const tx = buildTx([Operation.setOptions({ setFlags: 5, clearFlags: 2 })]);
    const content = render({ tx });
    expect(content).toContain('5 (AUTH_REQUIRED, AUTH_IMMUTABLE)');
    expect(content).toContain('2 (AUTH_REVOCABLE)');
    expect(content).toContain('Irreversible: AUTH_IMMUTABLE');
  });

  it('does not raise the irreversibility warning for other flags', () => {
    const tx = buildTx([Operation.setOptions({ setFlags: 1 })]);
    const content = render({ tx });
    expect(content).toContain('1 (AUTH_REQUIRED)');
    expect(content).not.toContain('Irreversible: AUTH_IMMUTABLE');
  });
});

describe('source account disclosure', () => {
  it('warns when the transaction source is not the signing account', () => {
    // Both values were always shown in full, but nothing said they differ,
    // and a user does not diff two 56-character strings by eye.
    const content = render({
      tx: buildTx([PAYMENT]),
      signingAddress: DESTINATION,
    });
    expect(content).toContain(SOURCE_MISMATCH_TITLE);
    expect(content).toContain('transaction source is');
  });

  it('warns when an operation source is not the signing account', () => {
    const tx = buildTx([
      Operation.payment({
        destination: DESTINATION,
        asset: Asset.native(),
        amount: '1',
        source: DESTINATION,
      }),
    ]);
    const content = render({ tx });
    expect(content).toContain(SOURCE_MISMATCH_TITLE);
    expect(content).toContain('Operation 1 acts for a source account');
  });

  it('stays quiet when every source is the signing account', () => {
    const content = render({ tx: buildTx([PAYMENT]) });
    expect(content).not.toContain(SOURCE_MISMATCH_TITLE);
  });

  it('stays quiet on a sequence-0 challenge, whose source is the server by design', () => {
    const content = render({
      tx: buildTx([PAYMENT], { sequence: '-1', timeout: 0 }),
      signingAddress: DESTINATION,
    });
    expect(content).not.toContain(SOURCE_MISMATCH_TITLE);
  });

  it('warns when a fee bump is paid by another account', () => {
    const inner = buildTx([PAYMENT]);
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      DESTINATION,
      '200',
      inner,
      Networks.TESTNET,
    );
    const foreign = render({ tx: bump });
    expect(foreign).toContain('Fee source is not the signing account');
    const own = render({ tx: bump, signingAddress: DESTINATION });
    expect(own).not.toContain('Fee source is not the signing account');
  });
});

describe('simulation provenance', () => {
  const SIMULATION = {
    ok: true as const,
    minResourceFee: '1000',
    authSigners: [],
    restoreRequired: false,
  };

  it('names the reporting endpoint and says the figures are unverified', () => {
    const content = render({
      tx: buildTx([PAYMENT]),
      simulation: SIMULATION,
      simulationEndpoint: 'https://soroban-testnet.stellar.org',
    });
    expect(content).toContain('Reported by soroban-testnet.stellar.org');
    expect(content).toContain('cannot independently verify');
  });

  it('renders an absent fee estimate as unavailable, never as zero', () => {
    const content = render({
      tx: buildTx([PAYMENT]),
      simulation: { ...SIMULATION, minResourceFee: null },
    });
    expect(content).toContain('unavailable (not reported by the endpoint)');
    expect(content).not.toContain('"0 XLM"');
  });

  it('lists the full identity behind every balance-change label', () => {
    const content = render({
      tx: buildTx([PAYMENT]),
      simulation: {
        ...SIMULATION,
        balanceChanges: {
          changes: [
            {
              asset: 'Token CDLZFC…HGCYSC',
              identity: CONTRACT,
              amount: '-1',
              rawUnits: true,
            },
          ],
          partial: false,
        },
      },
    });
    expect(content).toContain('Assets in full');
    expect(content).toContain(`Token CDLZFC…HGCYSC: ${CONTRACT}`);
  });
});

describe('authorization legend', () => {
  it('explains which entries the transaction signature itself authorizes', () => {
    const tx = buildTx([
      Operation.invokeContractFunction({
        contract: CONTRACT,
        function: 'transfer',
        args: [],
        auth: [
          new xdr.SorobanAuthorizationEntry({
            credentials:
              xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
            rootInvocation: new xdr.SorobanAuthorizedInvocation({
              function:
                xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                  new xdr.InvokeContractArgs({
                    contractAddress: Address.contract(
                      Buffer.alloc(32, 1),
                    ).toScAddress(),
                    functionName: 'transfer',
                    args: [],
                  }),
                ),
              subInvocations: [],
            }),
          }),
        ],
      }),
    ]);
    const content = render({ tx });
    expect(content).toContain('Authorizations (1)');
    expect(content).toContain(
      'Entries marked [source-account] are authorized by this transaction signature',
    );
  });
});

describe('offer, claimable-balance, and liquidity-pool renderers', () => {
  const USD = new Asset('USD', DESTINATION);

  it('renders a new sell offer with its exact rational price', () => {
    const tx = buildTx([
      Operation.manageSellOffer({
        selling: Asset.native(),
        buying: USD,
        amount: '10',
        price: { n: 1, d: 3 },
        offerId: '0',
      }),
    ]);
    const content = render({ tx });
    expect(content).toContain('Create sell offer');
    expect(content).toContain('10.0000000 XLM');
    // The SDK decodes 1/3 to a decimal it cannot represent exactly; the
    // dialog shows the stored ratio and marks the decimal as approximate.
    expect(content).toContain('1/3 (about 0.3333333)');
    expect(content).toContain(`USD:${DESTINATION}`);
  });

  it('names an offer update and an offer deletion', () => {
    const update = render({
      tx: buildTx([
        Operation.manageSellOffer({
          selling: Asset.native(),
          buying: USD,
          amount: '10',
          price: '2',
          offerId: '42',
        }),
      ]),
    });
    expect(update).toContain('Update sell offer #42');
    expect(update).toContain('2/1 (= 2)');
    const deletion = render({
      tx: buildTx([
        Operation.manageBuyOffer({
          selling: Asset.native(),
          buying: USD,
          buyAmount: '0',
          price: '2',
          offerId: '42',
        }),
      ]),
    });
    expect(deletion).toContain('Delete buy offer #42');
    expect(deletion).toContain('0 (removes offer #42)');
  });

  it('renders a passive sell offer and a buy offer', () => {
    const passive = render({
      tx: buildTx([
        Operation.createPassiveSellOffer({
          selling: USD,
          buying: Asset.native(),
          amount: '5',
          price: '1.5',
        }),
      ]),
    });
    expect(passive).toContain('Create passive sell offer');
    expect(passive).toContain('3/2 (= 1.5)');
    const buy = render({
      tx: buildTx([
        Operation.manageBuyOffer({
          selling: Asset.native(),
          buying: USD,
          buyAmount: '7',
          price: '4',
          offerId: '0',
        }),
      ]),
    });
    expect(buy).toContain('Create buy offer');
    expect(buy).toContain('7.0000000 USD');
    expect(buy).toContain('Paying with');
  });

  it('lists every claimant of a claimable balance with its condition in words', () => {
    const tx = buildTx([
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '25',
        claimants: [
          new Claimant(DESTINATION, Claimant.predicateUnconditional()),
          new Claimant(
            SOURCE,
            Claimant.predicateNot(
              Claimant.predicateBeforeAbsoluteTime('1700000000'),
            ),
          ),
          new Claimant(
            DESTINATION,
            Claimant.predicateAnd(
              Claimant.predicateBeforeRelativeTime('600'),
              Claimant.predicateOr(
                Claimant.predicateUnconditional(),
                Claimant.predicateBeforeAbsoluteTime('1800000000'),
              ),
            ),
          ),
        ],
      }),
    ]);
    const content = render({ tx });
    expect(content).toContain('Create claimable balance');
    expect(content).toContain('25.0000000 XLM');
    expect(content).toContain('Claimants (3)');
    expect(content).toContain(`#1 ${DESTINATION}\\ncan claim: unconditional`);
    expect(content).toContain(
      'NOT before unix time 1700000000 (2023-11-14T22:13:20.000Z)',
    );
    expect(content).toContain(
      '(within 600 seconds of the balance being created AND (unconditional OR before unix time 1800000000',
    );
    expect(findUndisplayableOperation(tx)).toBeNull();
  });

  it('refuses a claim predicate nested beyond the rendering bound', () => {
    let predicate = Claimant.predicateUnconditional();
    for (let level = 0; level < 12; level += 1) {
      predicate = Claimant.predicateNot(predicate);
    }
    const tx = buildTx([
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: '1',
        claimants: [new Claimant(DESTINATION, predicate)],
      }),
    ]);
    expect(findUndisplayableOperation(tx)).toContain('claim conditions');
  });

  it('renders a claim by balance ID', () => {
    const balanceId = `00000000${'ab'.repeat(32)}`;
    const tx = buildTx([Operation.claimClaimableBalance({ balanceId })]);
    const content = render({ tx });
    expect(content).toContain('Claim claimable balance');
    expect(content).toContain(balanceId);
  });

  it('renders pool deposits and withdrawals by pool ID with their bounds', () => {
    const poolId = 'cd'.repeat(32);
    const deposit = render({
      tx: buildTx([
        Operation.liquidityPoolDeposit({
          liquidityPoolId: poolId,
          maxAmountA: '100',
          maxAmountB: '200',
          minPrice: '0.5',
          maxPrice: { n: 3, d: 1 },
        }),
      ]),
    });
    expect(deposit).toContain('Deposit into liquidity pool');
    expect(deposit).toContain(poolId);
    expect(deposit).toContain('100.0000000');
    expect(deposit).toContain('1/2 (= 0.5)');
    expect(deposit).toContain('3/1 (= 3)');
    const withdraw = render({
      tx: buildTx([
        Operation.liquidityPoolWithdraw({
          liquidityPoolId: poolId,
          amount: '10',
          minAmountA: '1',
          minAmountB: '2',
        }),
      ]),
    });
    expect(withdraw).toContain('Withdraw from liquidity pool');
    expect(withdraw).toContain(poolId);
    expect(withdraw).toContain('Pool shares');
  });
});
