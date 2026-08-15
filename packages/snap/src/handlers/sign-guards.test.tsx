import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SLIP10Node } from '@metamask/key-tree';
import {
  Account,
  Address,
  Asset,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

import { signAuthEntry, signMessage, signTransaction } from './sign';
import { resetAddressCache } from '../keys';
import { resetRequestLimits, takePredialogBudget } from '../rpc/limiter';

/*
 * Fail-closed gate tests for the signing handlers.
 *
 * These guards are the confirmation-integrity claim in executable form: each
 * is a single `if` that refuses to open a dialog when part of what would be
 * signed cannot be rendered faithfully. Deleting any one of them silently
 * widens what the snap will sign, and nothing about the change looks wrong.
 *
 * The simulator suites exercise these behaviourally through `installSnap`,
 * but snaps-jest runs the built bundle, so none of it produces instrumented
 * coverage of `src/handlers/sign.tsx`: the module reported 0% branches while
 * being well tested, which means no coverage threshold could ever protect it.
 * Invoking the handlers directly against a mocked `snap` global (the pattern
 * `src/multi-account.test.tsx` uses for `onUserInput`) is what closes that
 * gap, so a dropped guard now fails a test rather than shipping.
 *
 * Every guard here must reject *before* any dialog is created, so each test
 * asserts on `dialogs` as well as the error.
 */

/**
 * Official SEP-0005 test vector 1 (no passphrase). Published in the spec, so
 * the keys it derives are publicly known: safe as fixtures precisely because
 * they are well-known, and never to hold real funds.
 */
const SEP5_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';

/*
 * Accounts 0 and 1 of that vector, `m/44'/148'/0'` and `m/44'/148'/1'`. These
 * are not interchangeable with arbitrary addresses: the mocked
 * `snap_getBip32Entropy` below returns the real subtree for SEP5_MNEMONIC, so
 * the handlers derive these exact values and the signer assertions only hold
 * because they match. Changing either breaks the suite, which is the point.
 */
const ADDRESS_0 = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const ADDRESS_1 = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ORIGIN = 'https://dapp.example';

let stored: unknown;
let dialogs: unknown[];
let dialogResponse: boolean;

/**
 * Builds a version-2 state object.
 *
 * @param overrides - Field overrides.
 * @returns The state object.
 */
function stateV2(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    network: 'TESTNET',
    activeAccount: 0,
    accounts: [0],
    origins: {},
    tokens: {},
    ...overrides,
  };
}

/** A state fragment granting {@link ORIGIN} a current-disclosure connection. */
const CONNECTED = {
  [ORIGIN]: { connectedAt: '2026-08-12T00:00:00Z', disclosureVersion: 1 },
};

describe('signing handlers: fail-closed gates', () => {
  beforeEach(async () => {
    const entropy = await SLIP10Node.fromDerivationPath({
      derivationPath: [`bip39:${SEP5_MNEMONIC}`, `slip10:44'`, `slip10:148'`],
      curve: 'ed25519',
    });
    stored = stateV2();
    dialogs = [];
    dialogResponse = true;
    // Module-level caches and budgets outlive a test otherwise: the address
    // cache and the entropy binding are per-execution-context, and the
    // pre-dialog budget is a global sliding window.
    resetAddressCache();
    resetRequestLimits();

    (globalThis as { snap?: unknown }).snap = {
      request: async (args: {
        method: string;
        params: { operation?: string; newState?: unknown; content?: unknown };
      }) => {
        await Promise.resolve();
        switch (args.method) {
          case 'snap_manageState':
            if (args.params.operation === 'get') {
              return stored;
            }
            stored = args.params.newState;
            return null;
          case 'snap_getBip32Entropy':
            return entropy.toJSON();
          case 'snap_dialog':
            dialogs.push(args.params.content);
            return dialogResponse;
          default:
            throw new Error(`Unexpected method: ${args.method}`);
        }
      },
    };

    // No guard under test may depend on the network. Anything that does reach
    // out fails, and the advisory lookups degrade to "could not check", so a
    // test that unexpectedly starts making requests fails loudly here instead
    // of silently hitting a real endpoint.
    (globalThis as { fetch?: unknown }).fetch = async () => {
      throw new Error('network disabled in this suite');
    };
  });

  afterEach(() => {
    delete (globalThis as { snap?: unknown }).snap;
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  /**
   * A classic single-payment transaction.
   *
   * @param sequence - The *account* sequence; the builder increments it.
   * @returns The built transaction.
   */
  function classicTx(sequence = '1') {
    return new TransactionBuilder(new Account(ADDRESS_0, sequence), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: ADDRESS_1,
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(300)
      .build();
  }

  /**
   * Builds a contract-data ledger key, used to pad a footprint.
   *
   * @param index - Distinguishes keys within one footprint.
   * @returns The ledger key.
   */
  function contractDataKey(index: number): xdr.LedgerKey {
    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(CONTRACT).toScAddress(),
        key: xdr.ScVal.scvU32(index),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
  }

  /**
   * A Soroban contract-invocation transaction.
   *
   * @param options - Fixture options.
   * @param options.args - Contract call arguments.
   * @param options.auth - Embedded authorization entries.
   * @param options.footprintKeys - Read-only footprint size; omit for none,
   * which is the "unprepared transaction" case.
   * @returns The built transaction.
   */
  function sorobanTx({
    args = [],
    auth = [],
    footprintKeys,
  }: {
    args?: xdr.ScVal[];
    auth?: xdr.SorobanAuthorizationEntry[];
    footprintKeys?: number;
  } = {}) {
    const builder = new TransactionBuilder(new Account(ADDRESS_0, '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    }).addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT,
        function: 'transfer',
        args,
        auth,
      }),
    );
    if (footprintKeys !== undefined) {
      builder.setSorobanData(
        new SorobanDataBuilder()
          .setFootprint(
            Array.from({ length: footprintKeys }, (_, index) =>
              contractDataKey(index),
            ),
            [],
          )
          .setResourceFee(1000n)
          .build(),
      );
    }
    return builder.setTimeout(300).build();
  }

  /**
   * An address-credential authorization entry naming the given account.
   *
   * @param address - The authorizing account.
   * @returns The authorization entry.
   */
  function addressAuthEntry(address: string): xdr.SorobanAuthorizationEntry {
    return new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(address).toScAddress(),
          nonce: new xdr.Int64(1n),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
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
  }

  describe('signTransaction: request-level gates', () => {
    it('refuses a mismatched network passphrase', async () => {
      await expect(
        signTransaction(ORIGIN, {
          xdr: classicTx().toXDR(),
          networkPassphrase: Networks.PUBLIC,
        }),
      ).rejects.toThrow('Network mismatch');
      expect(dialogs).toHaveLength(0);
    });

    it('requires the caller to state the network on PUBLIC', async () => {
      // `networkPassphrase` is optional in SEP-43, and when it is omitted the
      // envelope is hashed against whatever network the wallet happens to be
      // on. A site intending TESTNET while the wallet sits on PUBLIC would
      // otherwise receive a mainnet-valid signature with no network stated
      // anywhere in the exchange. Required only on PUBLIC, so test-network
      // ergonomics are untouched (every other test in this file omits it).
      const publicTx = new TransactionBuilder(new Account(ADDRESS_0, '1'), {
        fee: '100',
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(
          Operation.payment({
            destination: ADDRESS_1,
            asset: Asset.native(),
            amount: '1',
          }),
        )
        .setTimeout(300)
        .build();
      stored = stateV2({ network: 'PUBLIC' });

      await expect(
        signTransaction(ORIGIN, { xdr: publicTx.toXDR() }),
      ).rejects.toThrow('network passphrase is required');
      expect(dialogs).toHaveLength(0);

      // Stating it lets the request through to the dialog, so the guard bounds
      // the omission rather than the network.
      expect(
        await signTransaction(ORIGIN, {
          xdr: publicTx.toXDR(),
          networkPassphrase: Networks.PUBLIC,
        }),
      ).toMatchObject({ signerAddress: ADDRESS_0 });
      expect(dialogs).toHaveLength(1);
    });

    it('requires the caller to state the network on PUBLIC for signAuthEntry', async () => {
      stored = stateV2({ network: 'PUBLIC', origins: CONNECTED });
      await expect(
        signAuthEntry(ORIGIN, { authEntry: 'AAAA' }),
      ).rejects.toThrow('network passphrase is required');
      expect(dialogs).toHaveLength(0);
    });

    it('refuses XDR it cannot parse', async () => {
      await expect(
        signTransaction(ORIGIN, { xdr: 'bm90LXZhbGlkLXhkcg==' }),
      ).rejects.toThrow('Could not parse the transaction XDR.');
      expect(dialogs).toHaveLength(0);
    });

    it('refuses to submit a sequence-0 transaction', async () => {
      // The review dialog states such a transaction cannot execute, so honoring
      // `submit` would contradict the disclosure the user approved.
      const tx = classicTx('-1');
      expect(tx.sequence).toBe('0');
      await expect(
        signTransaction(ORIGIN, { xdr: tx.toXDR(), submit: true }),
      ).rejects.toThrow('can never execute on-chain');
      expect(dialogs).toHaveLength(0);
    });

    it('refuses an operation type it cannot display faithfully', async () => {
      const tx = new TransactionBuilder(new Account(ADDRESS_0, '1'), {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.bumpSequence({ bumpTo: '100' }))
        .setTimeout(300)
        .build();
      await expect(
        signTransaction(ORIGIN, { xdr: tx.toXDR() }),
      ).rejects.toThrow('cannot be reviewed');
      expect(dialogs).toHaveLength(0);
    });
  });

  describe('signTransaction: Soroban display gates', () => {
    it('refuses a Soroban transaction carrying no footprint', async () => {
      // The footprint bounds the whole signed state-access scope: two envelopes
      // can differ only in footprint keys while every other decoded field reads
      // identically.
      await expect(
        signTransaction(ORIGIN, { xdr: sorobanTx().toXDR() }),
      ).rejects.toThrow('carries no footprint');
      expect(dialogs).toHaveLength(0);
    });

    it('refuses a footprint too large to render in full', async () => {
      await expect(
        signTransaction(ORIGIN, {
          xdr: sorobanTx({ footprintKeys: 25 }).toXDR(),
        }),
      ).rejects.toThrow('touches more ledger entries');
      expect(dialogs).toHaveLength(0);
    });

    it('refuses contract-call arguments too large to display', async () => {
      // An argument shown as "…more" is undisclosed signed semantics.
      const args = Array.from({ length: 25 }, (_, index) =>
        xdr.ScVal.scvU32(index),
      );
      await expect(
        signTransaction(ORIGIN, {
          xdr: sorobanTx({ args, footprintKeys: 1 }).toXDR(),
        }),
      ).rejects.toThrow('too large or deeply nested to display in full');
      expect(dialogs).toHaveLength(0);
    });

    it('refuses more embedded auth entries than it renders', async () => {
      // Embedded entries are authorized by the envelope signature itself, so
      // they must be as reviewable as a standalone signAuthEntry request.
      const auth = Array.from({ length: 25 }, () =>
        addressAuthEntry(ADDRESS_1),
      );
      await expect(
        signTransaction(ORIGIN, {
          xdr: sorobanTx({ auth, footprintKeys: 1 }).toXDR(),
        }),
      ).rejects.toThrow('authorization data too large');
      expect(dialogs).toHaveLength(0);
    });
  });

  describe('signTransaction: account selection gating', () => {
    it('refuses an address option from an unconnected origin', async () => {
      // Resolution outcomes are observable, so an ungated selection is a
      // membership oracle over the wallet's accounts.
      await expect(
        signTransaction(ORIGIN, {
          xdr: classicTx().toXDR(),
          address: ADDRESS_1,
        }),
      ).rejects.toThrow('not connected');
      expect(dialogs).toHaveLength(0);
    });

    it('refuses the active address too, so it is not a membership oracle', async () => {
      // Exempting the active address would let an unconnected origin tell
      // "this guess is the active account" from "it is not".
      await expect(
        signTransaction(ORIGIN, {
          xdr: classicTx().toXDR(),
          address: ADDRESS_0,
        }),
      ).rejects.toThrow('not connected');
      expect(dialogs).toHaveLength(0);
    });

    it('refuses an address the wallet does not hold, even when connected', async () => {
      stored = stateV2({ origins: CONNECTED });
      const foreign =
        'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW';
      await expect(
        signTransaction(ORIGIN, {
          xdr: classicTx().toXDR(),
          address: foreign,
        }),
      ).rejects.toThrow('does not hold it');
      expect(dialogs).toHaveLength(0);
    });
  });

  describe('signAuthEntry gates', () => {
    /**
     * Serializes an auth entry for the handler.
     *
     * @param entry - The entry to encode.
     * @returns Base64 XDR.
     */
    const encode = (entry: xdr.SorobanAuthorizationEntry) =>
      entry.toXDR('base64');

    it('refuses source-account credentials', async () => {
      // Such an entry rides on the transaction signature and needs no separate
      // signature; signing one anyway would be a second, undisclosed grant.
      const entry = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: addressAuthEntry(ADDRESS_0).rootInvocation(),
      });
      await expect(
        signAuthEntry(ORIGIN, { authEntry: encode(entry) }),
      ).rejects.toThrow('needs no separate signature');
      expect(dialogs).toHaveLength(0);
    });

    it('refuses an entry it cannot parse', async () => {
      await expect(
        signAuthEntry(ORIGIN, { authEntry: 'bm90LWFuLWVudHJ5' }),
      ).rejects.toThrow('Could not parse the authorization entry XDR.');
      expect(dialogs).toHaveLength(0);
    });

    it('refuses an address option disagreeing with the entry', async () => {
      stored = stateV2({ origins: CONNECTED });
      await expect(
        signAuthEntry(ORIGIN, {
          authEntry: encode(addressAuthEntry(ADDRESS_0)),
          address: ADDRESS_1,
        }),
      ).rejects.toThrow('does not match the account named');
      expect(dialogs).toHaveLength(0);
    });

    it('refuses a mismatched network passphrase', async () => {
      await expect(
        signAuthEntry(ORIGIN, {
          authEntry: encode(addressAuthEntry(ADDRESS_0)),
          networkPassphrase: Networks.PUBLIC,
        }),
      ).rejects.toThrow('Network mismatch');
      expect(dialogs).toHaveLength(0);
    });

    it('fails closed when the ledger cannot be read', async () => {
      // Without the current ledger no expiry can be checked against the maximum
      // lifetime, so the request must not pass through unverified. `fetch` is
      // disabled in this suite, which is exactly that condition.
      stored = stateV2({ origins: CONNECTED });
      await expect(
        signAuthEntry(ORIGIN, {
          authEntry: encode(addressAuthEntry(ADDRESS_0)),
        }),
      ).rejects.toThrow('Could not reach the Stellar RPC');
      expect(dialogs).toHaveLength(0);
    });

    it('claims the global pre-dialog budget for its ledger lookups', async () => {
      // The finding this guards: these two ledger reads are pre-dialog network
      // work on a surface callable without a connection grant, and they drew on
      // no budget at all. Every other per-origin control here is keyed on
      // `origin` and resets per subdomain, so a site rotating origins could
      // drive unbounded traffic at Horizon and the RPC through this path.
      //
      // Draining the budget first must therefore stop the request, and stop it
      // *before* a dialog exists. Asserting on the distinct message is what
      // proves the budget is the cause, rather than the disabled `fetch` in
      // this suite producing the same fail-closed outcome for another reason.
      stored = stateV2({ origins: CONNECTED });
      while (takePredialogBudget(true)) {
        // Exhaust it.
      }
      await expect(
        signAuthEntry(ORIGIN, {
          authEntry: encode(addressAuthEntry(ADDRESS_0)),
        }),
      ).rejects.toThrow('Too many ledger lookups have run recently');
      expect(dialogs).toHaveLength(0);
    });

    it('requires a connection grant before it looks anything up', async () => {
      // This ordering is what keeps signAuthEntry off the cold-callable
      // amplification surface, and it is easy to lose in a refactor.
      //
      // An address-credential entry always names its authorizing account, and
      // `assertAccountSelectionAllowed` demands a grant for *any* named
      // address (including the active one, so the outcome cannot be used as a
      // membership oracle). Source-account entries are rejected earlier. So
      // every entry that reaches the ledger lookups has already passed the
      // grant check, and an ungated caller cannot drive a single request.
      //
      // The budget is deliberately drained here: if the grant check ever moved
      // below the lookups, this test would fail on the budget message instead
      // of the not-connected one, rather than passing quietly.
      while (takePredialogBudget(false)) {
        // Exhaust the cold share.
      }
      await expect(
        signAuthEntry(ORIGIN, {
          authEntry: encode(addressAuthEntry(ADDRESS_0)),
        }),
      ).rejects.toThrow('Origin is not connected');
      expect(dialogs).toHaveLength(0);
    });
  });

  describe('an approved signature survives an ancillary state failure', () => {
    /**
     * Makes every `snap_manageState` write fail, leaving reads working.
     *
     * Models a store that cannot be written: a platform size limit, or a
     * transient failure. Reads must keep working, because the handler needs
     * state to get as far as the dialog in the first place.
     */
    type SnapRequest = (args: {
      method: string;
      params: { operation?: string };
    }) => Promise<unknown>;

    /** Installs the failing-write wrapper over the mocked `snap` global. */
    function failStateWrites() {
      const snapGlobal = (
        globalThis as unknown as { snap: { request: SnapRequest } }
      ).snap;
      const original = snapGlobal.request.bind(snapGlobal);
      snapGlobal.request = async (args) => {
        if (
          args.method === 'snap_manageState' &&
          args.params.operation !== 'get'
        ) {
          throw new Error('state store unavailable');
        }
        return original(args);
      };
    }

    it('still returns a signed transaction when the grant cannot be recorded', async () => {
      // The finding this guards: `connectOrigin` sat unguarded between the
      // approval and `tx.sign()`, so any state-write failure turned an approved
      // signature into a generic internal error. The user had already consented;
      // recording an ancillary grant must not be able to undo that.
      failStateWrites();
      const result = await signTransaction(ORIGIN, {
        xdr: classicTx().toXDR(),
      });
      expect(dialogs).toHaveLength(1);
      expect(result.signerAddress).toBe(ADDRESS_0);
      const signed = TransactionBuilder.fromXDR(
        result.signedTxXdr,
        Networks.TESTNET,
      );
      expect(signed.signatures).toHaveLength(1);
    });

    it('still returns a signature from signMessage', async () => {
      failStateWrites();
      const result = await signMessage(ORIGIN, { message: 'hello' });
      expect(dialogs).toHaveLength(1);
      expect(result.signerAddress).toBe(ADDRESS_0);
      expect(result.signedMessage).toStrictEqual(expect.any(String));
    });
  });

  describe('signMessage gating', () => {
    it('refuses an address option from an unconnected origin', async () => {
      await expect(
        signMessage(ORIGIN, { message: 'hello', address: ADDRESS_0 }),
      ).rejects.toThrow('not connected');
      expect(dialogs).toHaveLength(0);
    });

    it('signs for the active account without a grant (cold signing)', async () => {
      // Positive control. Cold signing with the active account is deliberate
      // SEP-43 parity behaviour, and it proves the harness reaches the dialog
      // at all: without it, every guard test above could pass for the wrong
      // reason.
      const result = await signMessage(ORIGIN, { message: 'hello' });
      expect(dialogs).toHaveLength(1);
      expect(result.signerAddress).toBe(ADDRESS_0);
      expect(result.signedMessage).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    });

    it('rejects when the user declines', async () => {
      dialogResponse = false;
      await expect(signMessage(ORIGIN, { message: 'hello' })).rejects.toThrow(
        'The user rejected this request.',
      );
      expect(dialogs).toHaveLength(1);
    });
  });

  describe('signTransaction: submission integrity', () => {
    /**
     * Installs a fetch stub answering Horizon submissions with `body` and every
     * other lookup with a 404, so the advisory account checks stay inert.
     *
     * @param body - The JSON body returned for `POST /transactions`.
     * @param status - The HTTP status for that response.
     */
    function stubHorizon(body: unknown, status = 200) {
      (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
        await Promise.resolve();
        const submitting = String(url).includes('/transactions');
        const payload = Buffer.from(
          JSON.stringify(submitting ? body : { status: 404 }),
          'utf8',
        );
        return {
          ok: submitting ? status >= 200 && status < 300 : false,
          status: submitting ? status : 404,
          headers: { get: () => null },
          arrayBuffer: async () => payload,
        };
      };
    }

    it('refuses a submission hash that does not match what was signed', async () => {
      // Submission responses are endpoint-controlled input. A compromised
      // endpoint must not be able to make the snap report an unrelated
      // transaction as the one it submitted.
      stubHorizon({ hash: 'a'.repeat(64) });
      await expect(
        signTransaction(ORIGIN, { xdr: classicTx().toXDR(), submit: true }),
      ).rejects.toThrow('does not match the signed transaction');
      expect(dialogs).toHaveLength(1);
    });

    it('accepts a submission hash matching the signed envelope', async () => {
      const tx = classicTx();
      // The handler signs before submitting, so the expected hash is the hash
      // of the signed envelope, not the unsigned one. Recompute it the same way
      // the handler does.
      const signed = TransactionBuilder.fromXDR(
        tx.toXDR(),
        Networks.TESTNET,
      ) as ReturnType<typeof classicTx>;
      const { deriveKeypair } = await import('../keys');
      signed.sign(await deriveKeypair(0));
      const expected = signed.hash().toString('hex');

      stubHorizon({ hash: expected });
      const result = await signTransaction(ORIGIN, {
        xdr: tx.toXDR(),
        submit: true,
      });
      expect(result.hash).toBe(expected);
    });

    it('returns the signed envelope alongside a submission failure', async () => {
      // The user did sign, and on a timeout the transaction may still land, so
      // the dapp needs the envelope to poll or retry.
      stubHorizon({ detail: 'boom' }, 500);
      await expect(
        signTransaction(ORIGIN, { xdr: classicTx().toXDR(), submit: true }),
      ).rejects.toMatchObject({
        data: { signedTxXdr: expect.any(String), signerAddress: ADDRESS_0 },
      });
    });
  });

  describe('signTransaction reaches the dialog when every gate passes', () => {
    it('opens a review dialog for an ordinary classic payment', async () => {
      // The second positive control: the classic path must still work, with the
      // safety lookups degrading quietly because the network is disabled here.
      const result = await signTransaction(ORIGIN, {
        xdr: classicTx().toXDR(),
      });
      expect(dialogs).toHaveLength(1);
      expect(result.signerAddress).toBe(ADDRESS_0);
      // The returned envelope must carry the signature, not merely exist:
      // re-parsing it is what proves a signature was actually attached.
      const signed = TransactionBuilder.fromXDR(
        result.signedTxXdr,
        Networks.TESTNET,
      );
      expect(signed.signatures).toHaveLength(1);
    });

    it('records a connection grant once a signature is approved', async () => {
      await signTransaction(ORIGIN, { xdr: classicTx().toXDR() });
      expect(
        (stored as { origins: Record<string, unknown> }).origins[ORIGIN],
      ).toBeDefined();
    });
  });
});
