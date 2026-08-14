import { describe, expect, it } from '@jest/globals';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import { buildSignTransactionDialog } from './transaction';

/*
 * Disclosure tests for the transaction review dialog: the properties that
 * decide whether what the user reads matches what the signature actually
 * permits. The fuzz suite next door proves the dialog never throws and never
 * leaks hidden characters; this one proves specific facts are *present*.
 *
 * Both findings covered here are absence bugs, which is why they need
 * dedicated assertions: nothing throws, nothing renders wrong, a row is
 * simply missing, and a missing row reads to the user as "not applicable".
 */

/*
 * Accounts 0 and 1 of official SEP-0005 test vector 1, the same fixtures the
 * rest of the suite uses. Their mnemonic is published in the spec, so their
 * private keys are publicly derivable: they are safe here precisely because
 * they are well-known, and must never hold real funds.
 *
 * Nothing in this file derives or signs, so the specific values carry no
 * meaning beyond being valid, checksum-correct addresses. They are shared
 * with the other suites only so a reader recognises them on sight.
 */
const SOURCE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const DESTINATION = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const ORIGIN = 'https://dapp.example';

/**
 * Builds a one-payment transaction with the given timeout semantics.
 *
 * @param timeout - `setTimeout` argument; 0 means no upper time bound.
 * @param sequence - The *account* sequence. `TransactionBuilder` increments
 * it, so `'-1'` is what yields a sequence-0 (challenge-style) envelope, and
 * `'0'` would yield sequence 1.
 * @returns The built transaction.
 */
function buildTx(timeout: number, sequence = '1') {
  return new TransactionBuilder(new Account(SOURCE, sequence), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: DESTINATION,
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(timeout)
    .build();
}

/**
 * Renders a dialog to its JSON form for structural assertions.
 *
 * @param overrides - Dialog parameter overrides.
 * @returns The serialized dialog.
 */
function render(
  overrides: Partial<Parameters<typeof buildSignTransactionDialog>[0]> = {},
) {
  const tx = overrides.tx ?? buildTx(300);
  return JSON.stringify(
    buildSignTransactionDialog({
      origin: ORIGIN,
      network: 'TESTNET',
      tx,
      xdr: tx.toXDR(),
      signingAddress: SOURCE,
      accountIndex: 0,
      ...overrides,
    }),
  );
}

describe('transaction validity disclosure', () => {
  it('states the expiry when the transaction sets one', () => {
    const content = render({ tx: buildTx(300) });
    expect(content).toContain('Valid until');
    expect(content).not.toContain('No expiry');
  });

  it('states explicitly that an unbounded transaction never expires', () => {
    // Regression: `formatTimeBound` returned null for an unset maxTime and
    // the row was skipped entirely, so a transaction that stays submittable
    // forever rendered identically to one expiring in five minutes. Absence
    // of the row reads as "not applicable", not as "no expiry", and the dapp
    // holds the signed envelope on the default non-submitting path.
    const content = render({ tx: buildTx(0) });
    expect(content).toContain('Valid until');
    expect(content).toContain('No expiry');
    expect(content).toContain('submittable at any future time');
  });

  it('raises a banner for an unbounded transaction', () => {
    const content = render({ tx: buildTx(0) });
    expect(content).toContain('This signature never expires');
  });

  it('raises no expiry banner when a bound is set', () => {
    const content = render({ tx: buildTx(300) });
    expect(content).not.toContain('This signature never expires');
  });

  it('stays quiet about expiry on a sequence-0 challenge', () => {
    // A sequence-0 envelope can never execute, so its absent expiry is moot
    // and the banner would be noise on a login challenge whose own branch
    // already says it cannot be submitted.
    const tx = buildTx(0, '-1');
    // Pin the fixture: TransactionBuilder increments the account sequence, so
    // an off-by-one here would silently make this a different test.
    expect(tx.sequence).toBe('0');
    expect(render({ tx })).not.toContain('This signature never expires');
  });

  it('covers a fee bump through its inner transaction', () => {
    // The inner transaction carries the time bounds, and the fee-bump branch
    // renders its summary, so the disclosure must reach through the wrapper.
    const inner = buildTx(0);
    inner.sign(Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)));
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      SOURCE,
      '200',
      inner,
      Networks.TESTNET,
    );
    const content = render({ tx: feeBump, xdr: feeBump.toXDR() });
    expect(content).toContain('This signature never expires');
  });
});

describe('submission endpoint disclosure', () => {
  it('names the host that receives the signed envelope', () => {
    // The submission endpoint is trusted with more than display: it can
    // accept an envelope, report its correct hash, and never broadcast,
    // retaining a valid signed transaction. On PUBLIC the Soroban path is a
    // third-party gateway, which the network name alone does not reveal.
    const content = render({
      submit: true,
      submitEndpoint: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
    });
    expect(content).toContain('Submitted via');
    expect(content).toContain('soroban-rpc.mainnet.stellar.gateway.fm');
    expect(content).toContain('delay or withhold');
  });

  it('shows the host only, not the full URL with scheme', () => {
    const content = render({
      submit: true,
      submitEndpoint: 'https://horizon.stellar.org',
    });
    expect(content).toContain('horizon.stellar.org');
    expect(content).not.toContain('https://horizon.stellar.org');
  });

  it('falls back to the raw value when the endpoint will not parse', () => {
    // A malformed configuration must still be disclosed, never silently
    // dropped from the banner.
    const content = render({ submit: true, submitEndpoint: 'not a url' });
    expect(content).toContain('not a url');
  });

  it('discloses nothing about submission when submit is not requested', () => {
    const content = render({ submitEndpoint: 'https://horizon.stellar.org' });
    expect(content).not.toContain('Submitted via');
  });

  it('still warns that submission is irreversible', () => {
    const content = render({
      submit: true,
      submitEndpoint: 'https://horizon.stellar.org',
    });
    expect(content).toContain('Sign and submit');
    expect(content).toContain('cannot be undone');
  });
});

describe('dialog invariants preserved by the disclosure changes', () => {
  it('keeps the raw XDR present on every branch', () => {
    const regular = buildTx(0);
    const challenge = buildTx(0, '-1');
    for (const tx of [regular, challenge]) {
      const content = render({ tx, xdr: tx.toXDR() });
      expect(content).toContain(tx.toXDR());
    }
  });

  it('renders the mainnet submit path without throwing', () => {
    const tx = buildTx(0);
    expect(() =>
      buildSignTransactionDialog({
        origin: ORIGIN,
        network: 'PUBLIC',
        tx,
        xdr: tx.toXDR(),
        signingAddress: SOURCE,
        accountIndex: 0,
        submit: true,
        submitEndpoint: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
      }),
    ).not.toThrow();
  });

  it('shows the mainnet, expiry, and endpoint cautions together', () => {
    // The worst combination in one dialog: real funds, a signature that never
    // expires, and a third-party relay holding it. None of the three may
    // crowd the others out.
    const tx = buildTx(0);
    const content = JSON.stringify(
      buildSignTransactionDialog({
        origin: ORIGIN,
        network: 'PUBLIC',
        tx,
        xdr: tx.toXDR(),
        signingAddress: SOURCE,
        accountIndex: 0,
        submit: true,
        submitEndpoint: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
      }),
    );
    expect(content).toContain('Mainnet');
    expect(content).toContain('This signature never expires');
    expect(content).toContain('Submitted via');
  });
});
