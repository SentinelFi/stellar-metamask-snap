import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SLIP10Node } from '@metamask/key-tree';
import { installSnap } from '@metamask/snaps-jest';
import { UserInputEventType } from '@metamask/snaps-sdk';
import {
  Account,
  hash,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import { onUserInput } from '.';
import { resetAddressCache } from './keys';
import { MAX_ACCOUNT_INDEX } from './state';

/** Official SEP-0005 test vector 1 (no passphrase). */
const SEP5_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';
const SEP5_ADDRESS_0 =
  'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const SEP5_ADDRESS_1 =
  'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const SEP5_ADDRESS_2 =
  'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW';

/**
 * A well-formed address this wallet does not hold, derived here from a fixed
 * synthetic seed rather than hardcoded: the value is self-evidently a test
 * artifact and cannot collide with a real account someone controls.
 */
const FOREIGN_ADDRESS = Keypair.fromRawEd25519Seed(
  Buffer.alloc(32, 7),
).publicKey();

const ORIGIN = 'https://dapp.example';

/** A state fragment granting {@link ORIGIN} a current-disclosure connection. */
const CONNECTED = {
  [ORIGIN]: { connectedAt: '2026-08-12T00:00:00Z', disclosureVersion: 1 },
};

/**
 * A grant recorded before account enumeration was disclosed: no
 * disclosureVersion, exactly as every pre-existing and migrated grant looks.
 */
const PRE_DISCLOSURE = { [ORIGIN]: { connectedAt: '2026-08-12T00:00:00Z' } };

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

/**
 * Installs the snap with the SEP-5 test mnemonic.
 *
 * @param state - Optional initial snap state.
 * @returns The snaps-jest helpers.
 */
async function install(state?: Record<string, unknown>) {
  return installSnap({
    options: {
      secretRecoveryPhrase: SEP5_MNEMONIC,
      ...(state ? { state: state as never } : {}),
    },
  });
}

/**
 * Extracts the JSON-RPC error object from a snaps-jest response.
 *
 * @param response - The awaited request response.
 * @returns The error object.
 */
function getError(response: unknown): {
  message: string;
  data?: { code?: number };
} {
  return (response as { response: { error: never } }).response.error;
}

/**
 * Extracts the JSON-RPC result from a snaps-jest response. The result is
 * JSON round-tripped so null-prototype objects compare as plain objects.
 *
 * @param response - The awaited request response.
 * @returns The result value.
 */
function getResult<Type>(response: unknown): Type {
  return JSON.parse(
    JSON.stringify(
      (response as { response: { result: Type } }).response.result,
    ),
  ) as Type;
}

describe('getAccounts', () => {
  it('requires a connected origin', async () => {
    const { request } = await install();
    const error = getError(
      await request({ origin: ORIGIN, method: 'getAccounts' }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('not connected');
  }, 45000);

  it('enumerates revealed accounts against the SEP-5 vectors', async () => {
    const { request } = await install(
      stateV2({ accounts: [0, 1, 2], origins: CONNECTED }),
    );
    const result = getResult<{
      accounts: { index: number; address: string }[];
      activeIndex: number;
    }>(await request({ origin: ORIGIN, method: 'getAccounts' }));

    // Index 0..2 must match the official SEP-0005 test-vector addresses.
    expect(result).toStrictEqual({
      accounts: [
        { index: 0, address: SEP5_ADDRESS_0 },
        { index: 1, address: SEP5_ADDRESS_1 },
        { index: 2, address: SEP5_ADDRESS_2 },
      ],
      activeIndex: 0,
    });
  }, 45000);
});

describe('setActiveAccount', () => {
  it('switches after confirmation and getAddress reflects it', async () => {
    const { request } = await install(
      stateV2({ accounts: [0, 1], origins: CONNECTED }),
    );

    const pending = request({
      origin: ORIGIN,
      method: 'setActiveAccount',
      params: { index: 1 },
    });
    const ui = await pending.getInterface();
    const content = JSON.stringify(ui.content);
    expect(content).toContain('Switch account');
    expect(content).toContain('Account 1');
    expect(content).toContain(SEP5_ADDRESS_1);
    await (ui as { ok: () => Promise<void> }).ok();

    expect(getResult(await pending)).toStrictEqual({
      index: 1,
      address: SEP5_ADDRESS_1,
    });

    const address = getResult<{ address: string }>(
      await request({ origin: ORIGIN, method: 'getAddress' }),
    );
    expect(address.address).toBe(SEP5_ADDRESS_1);
  }, 45000);

  it('rejects a non-revealed index without a dialog', async () => {
    const { request } = await install(
      stateV2({ accounts: [0, 1], origins: CONNECTED }),
    );
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'setActiveAccount',
        params: { index: 2 },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('Unknown account index');
  }, 45000);

  it('rejects a malformed index', async () => {
    const { request } = await install(stateV2({ origins: CONNECTED }));
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'setActiveAccount',
        params: { index: 1.5 },
      }),
    );
    expect(error.data?.code).toBe(-3);
  }, 45000);

  it('keeps the active account on user rejection', async () => {
    const { request } = await install(
      stateV2({ accounts: [0, 1], origins: CONNECTED }),
    );

    const pending = request({
      origin: ORIGIN,
      method: 'setActiveAccount',
      params: { index: 1 },
    });
    const ui = await pending.getInterface();
    await (ui as { cancel: () => Promise<void> }).cancel();
    expect(getError(await pending).data?.code).toBe(-4);

    const address = getResult<{ address: string }>(
      await request({ origin: ORIGIN, method: 'getAddress' }),
    );
    expect(address.address).toBe(SEP5_ADDRESS_0);
  }, 45000);
});

describe('signing with the address option', () => {
  it('signMessage signs with the selected revealed account', async () => {
    const { request } = await install(
      stateV2({ accounts: [0, 1], origins: CONNECTED }),
    );

    const message = 'multi-account test';
    const pending = request({
      origin: ORIGIN,
      method: 'signMessage',
      params: { message, address: SEP5_ADDRESS_1 },
    });
    const ui = await pending.getInterface();
    const content = JSON.stringify(ui.content);
    // Display integrity: the dialog names the selected account.
    expect(content).toContain('Account 1');
    expect(content).toContain(SEP5_ADDRESS_1);
    await (ui as { ok: () => Promise<void> }).ok();

    const result = getResult<{ signedMessage: string; signerAddress: string }>(
      await pending,
    );
    expect(result.signerAddress).toBe(SEP5_ADDRESS_1);

    // The signature must actually come from account 1's key (SEP-53).
    const payload = hash(
      Buffer.concat([
        Buffer.from('Stellar Signed Message:\n', 'utf8'),
        Buffer.from(message, 'utf8'),
      ]),
    );
    expect(
      Keypair.fromPublicKey(SEP5_ADDRESS_1).verify(
        payload,
        Buffer.from(result.signedMessage, 'base64'),
      ),
    ).toBe(true);
  }, 45000);

  it('signMessage without an address signs with the active account', async () => {
    const { request } = await install(
      stateV2({ accounts: [0, 1], activeAccount: 1, origins: CONNECTED }),
    );

    const pending = request({
      origin: ORIGIN,
      method: 'signMessage',
      params: { message: 'hello' },
    });
    const ui = await pending.getInterface();
    await (ui as { ok: () => Promise<void> }).ok();
    const result = getResult<{ signerAddress: string }>(await pending);
    expect(result.signerAddress).toBe(SEP5_ADDRESS_1);
  }, 45000);

  it('rejects an address the wallet does not hold', async () => {
    const { request } = await install(
      stateV2({ accounts: [0, 1], origins: CONNECTED }),
    );

    // Index 2 is derivable but not revealed: it must not be signable.
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signMessage',
        params: { message: 'hello', address: SEP5_ADDRESS_2 },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('Unknown address');
  }, 45000);

  it('gives an unconnected origin the same answer for held and foreign addresses', async () => {
    // Regression: resolution used to run before any grant check, so an
    // origin with no grant could tell a held address (dialog) from a foreign
    // one (silent "Unknown address") and thereby test arbitrary addresses
    // against the wallet. Selecting an account now needs a grant, and the
    // check runs first, so both cases are indistinguishable.
    const { request } = await install(stateV2({ accounts: [0, 1] }));
    const hostile = 'https://evil.example';

    const held = getError(
      await request({
        origin: hostile,
        method: 'signMessage',
        params: { message: 'x', address: SEP5_ADDRESS_1 },
      }),
    );
    const foreign = getError(
      await request({
        origin: hostile,
        method: 'signMessage',
        params: { message: 'x', address: FOREIGN_ADDRESS },
      }),
    );

    expect(held.message).toContain('not connected');
    expect(held.message).toBe(foreign.message);
    expect(held.data?.code).toBe(foreign.data?.code);
  }, 45000);

  it('still lets an unconnected origin cold-sign with the active account', async () => {
    // The gate covers account *selection*, not signing: SEP-43 cold signing
    // with the active account is deliberate and must keep working.
    const { request } = await install(
      stateV2({ accounts: [0, 1], activeAccount: 1 }),
    );

    const pending = request({
      origin: 'https://cold.example',
      method: 'signMessage',
      params: { message: 'hello' },
    });
    const ui = await pending.getInterface();
    await (ui as { ok: () => Promise<void> }).ok();
    expect(
      getResult<{ signerAddress: string }>(await pending).signerAddress,
    ).toBe(SEP5_ADDRESS_1);
  }, 45000);

  it('refuses an unconnected origin naming even the active account', async () => {
    // Naming the active address used to be exempt from the grant, which let
    // an unconnected origin distinguish "this guess is the active account"
    // (request pends on a dialog) from "it is not" (immediate rejection): a
    // membership probe. Every explicit address now requires a grant; the
    // answer must match the held/foreign cases exactly.
    const { request } = await install(
      stateV2({ accounts: [0, 1], activeAccount: 1 }),
    );

    const active = getError(
      await request({
        origin: 'https://cold.example',
        method: 'signMessage',
        params: { message: 'hello', address: SEP5_ADDRESS_1 },
      }),
    );
    const foreign = getError(
      await request({
        origin: 'https://cold.example',
        method: 'signMessage',
        params: { message: 'hello', address: FOREIGN_ADDRESS },
      }),
    );
    expect(active.message).toContain('not connected');
    expect(active.message).toBe(foreign.message);
    expect(active.data?.code).toBe(foreign.data?.code);
  }, 45000);

  it('signTransaction resolves the address option to the revealed account', async () => {
    const { request } = await install(
      stateV2({ accounts: [0, 1], origins: CONNECTED }),
    );

    // A sequence-0 (challenge-style) transaction avoids network lookups.
    const transaction = new TransactionBuilder(
      new Account(SEP5_ADDRESS_1, '-1'),
      {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      },
    )
      .addOperation(Operation.manageData({ name: 'test auth', value: 'value' }))
      .setTimeout(300)
      .build();

    const pending = request({
      origin: ORIGIN,
      method: 'signTransaction',
      params: { xdr: transaction.toXDR(), address: SEP5_ADDRESS_1 },
    });
    const ui = await pending.getInterface();
    const content = JSON.stringify(ui.content);
    expect(content).toContain('Account 1');
    await (ui as { ok: () => Promise<void> }).ok();

    const result = getResult<{ signerAddress: string; signedTxXdr: string }>(
      await pending,
    );
    expect(result.signerAddress).toBe(SEP5_ADDRESS_1);

    const signed = TransactionBuilder.fromXDR(
      result.signedTxXdr,
      Networks.TESTNET,
    );
    const signature = signed.signatures[0]?.signature();
    expect(signature).toBeDefined();
    expect(
      Keypair.fromPublicKey(SEP5_ADDRESS_1).verify(
        signed.hash(),
        signature as Buffer,
      ),
    ).toBe(true);
  }, 45000);
});

describe('home page account management', () => {
  it('lists accounts and switches the active one via Use', async () => {
    const { request, onHomePage } = await install(
      stateV2({ accounts: [0, 1], origins: CONNECTED }),
    );

    const home = (await onHomePage()) as unknown as {
      getInterface: () => Promise<{
        content: unknown;
        clickElement: (name: string) => Promise<void>;
      }>;
    };
    const ui = await home.getInterface();
    const content = JSON.stringify(ui.content);
    expect(content).toContain('Account 0');
    expect(content).toContain('Account 1');
    expect(content).toContain('add-account');

    await ui.clickElement('use-account:1');

    const address = getResult<{ address: string }>(
      await request({ origin: ORIGIN, method: 'getAddress' }),
    );
    expect(address.address).toBe(SEP5_ADDRESS_1);
  }, 45000);
});

/*
 * The Add-account flow opens a confirmation dialog inside `onUserInput`,
 * which snaps-jest cannot reach (its home-page `getInterface` is bound to
 * the home page's interface ID). Exercise the handler directly against a
 * mocked `snap` global instead, with real SLIP-10 derivation.
 */
/**
 * Makes every state write fail, leaving reads working.
 *
 * Declared at module scope because the method check is a conditional, and
 * `jest/no-conditional-in-test` (rightly) refuses those in a test body.
 * `afterEach` deletes the global, so there is nothing to restore.
 */
function failStateWrites(): void {
  const host = globalThis as unknown as {
    snap: {
      request: (args: {
        method: string;
        params: { operation?: string };
      }) => Promise<unknown>;
    };
  };
  const real = host.snap.request;
  host.snap.request = async (args: {
    method: string;
    params: { operation?: string };
  }) => {
    if (args.method === 'snap_manageState' && args.params.operation !== 'get') {
      throw new Error('state unavailable');
    }
    return real(args);
  };
}

describe('onUserInput add-account flow', () => {
  let stored: unknown;
  let dialogs: unknown[];
  let dialogResponse: boolean;
  let updates: number;

  beforeEach(async () => {
    const entropy = await SLIP10Node.fromDerivationPath({
      derivationPath: [`bip39:${SEP5_MNEMONIC}`, `slip10:44'`, `slip10:148'`],
      curve: 'ed25519',
    });
    stored = stateV2({ origins: CONNECTED });
    dialogs = [];
    dialogResponse = true;
    updates = 0;
    // The address cache and the entropy-binding latch are module state that
    // outlives a test. Each test here swaps in a fresh store, and a latch
    // still warm from the previous test would stop the binding reconciliation
    // from writing the fingerprint into it, so the reveal flows' commit-time
    // fingerprint comparison would refuse stores that were simply fresh.
    resetAddressCache();
    (globalThis as { snap?: unknown }).snap = {
      request: async (args: {
        method: string;
        params: {
          operation?: string;
          newState?: unknown;
          content?: unknown;
        };
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
          case 'snap_updateInterface':
            updates += 1;
            return null;
          default:
            throw new Error(`Unexpected method: ${args.method}`);
        }
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { snap?: unknown }).snap;
  });

  /**
   * Clicks a home-page button by invoking the snap's onUserInput handler.
   *
   * @param name - The button name.
   */
  async function click(name: string) {
    await onUserInput({
      id: 'test-interface',
      event: { type: UserInputEventType.ButtonClickEvent, name },
      context: null,
    } as never);
  }

  /**
   * Submits the home-page account-lookup form.
   *
   * @param query - The lookup input (an address or an index).
   */
  async function submitLookup(query: string) {
    await onUserInput({
      id: 'test-interface',
      event: {
        type: UserInputEventType.FormSubmitEvent,
        name: 'find-account',
        value: { 'find-account-query': query },
      },
      context: null,
    } as never);
  }

  it('reports a failed interaction instead of throwing out of the handler', async () => {
    // Disconnect is the simplest interaction that writes, so failing writes
    // makes the state helper throw on a path with no other error handling.
    failStateWrites();

    // An escaping throw would surface as a bare platform error and skip the
    // re-render, leaving the page showing state that may already have moved.
    await click(`disconnect:${ORIGIN}`);

    // The user was told, and the page was re-read rather than left stale.
    expect(dialogs).toHaveLength(1);
    expect(updates).toBe(1);
  });

  it('reveals the next account after confirmation', async () => {
    await click('add-account');

    // The confirmation showed the derived index-1 address before commit.
    expect(dialogs).toHaveLength(1);
    const dialogContent = JSON.stringify(dialogs[0]);
    expect(dialogContent).toContain('Add account');
    expect(dialogContent).toContain(SEP5_ADDRESS_1);

    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0, 1]);
    expect(updates).toBe(1);
  });

  it('does not reveal an account when the dialog is rejected', async () => {
    dialogResponse = false;
    await click('add-account');

    expect(dialogs).toHaveLength(1);
    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0]);
    expect(updates).toBe(0);
  });

  it('switches the active account via Use without a dialog', async () => {
    stored = stateV2({ accounts: [0, 1], origins: CONNECTED });
    await click('use-account:1');

    expect(dialogs).toHaveLength(0);
    expect((stored as { activeAccount: number }).activeAccount).toBe(1);
    expect(updates).toBe(1);
  });

  it('ignores a malformed account index', async () => {
    await click('use-account:oops');
    expect((stored as { activeAccount: number }).activeAccount).toBe(0);
    expect(updates).toBe(0);
  });

  it('ignores numeric forms this page never renders', async () => {
    // Regression: a bare `Number()` conversion reads an empty suffix as 0 and
    // accepts hex, exponent, and padded forms. Only the plain decimal shape
    // the page emits may select an account.
    stored = stateV2({
      accounts: [0, 1],
      activeAccount: 1,
      origins: CONNECTED,
    });
    for (const suffix of ['', ' ', '0x0', '1e0', ' 0 ', '+0', '0.0', '00']) {
      await click(`use-account:${suffix}`);
      expect((stored as { activeAccount: number }).activeAccount).toBe(1);
    }
    expect(updates).toBe(0);
  });

  it('ignores an index the user has not revealed', async () => {
    // A button name from a stale page must not activate an unrevealed
    // account, even though the index itself is well-formed and derivable.
    stored = stateV2({ accounts: [0, 1], origins: CONNECTED });
    await click('use-account:5');

    expect((stored as { activeAccount: number }).activeAccount).toBe(0);
    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0, 1]);
    expect(updates).toBe(0);
  });

  it('refuses to reveal past the account cap', async () => {
    stored = stateV2({
      accounts: Array.from({ length: MAX_ACCOUNT_INDEX }, (_, i) => i),
      origins: CONNECTED,
    });
    await click('add-account');

    // The cap is reported to the user, and nothing is added.
    expect(JSON.stringify(dialogs)).toContain('Account limit reached');
    expect((stored as { accounts: number[] }).accounts).toHaveLength(
      MAX_ACCOUNT_INDEX,
    );
    expect(updates).toBe(0);
  });

  it('locates an account by address and reveals through it in one step', async () => {
    // The point of the lookup: someone holding this address in another
    // SEP-0005 wallet reaches it with one confirmation, not one per index.
    await submitLookup(SEP5_ADDRESS_2);

    expect(dialogs).toHaveLength(1);
    const content = JSON.stringify(dialogs[0]);
    expect(content).toContain(SEP5_ADDRESS_2);
    // The run of accounts it also reveals is disclosed, not silent.
    expect(content).toContain('gap-free');

    expect((stored as { accounts: number[] }).accounts).toStrictEqual([
      0, 1, 2,
    ]);
    expect(updates).toBe(1);
  });

  it('locates an account by index', async () => {
    await submitLookup('2');

    expect(JSON.stringify(dialogs[0])).toContain(SEP5_ADDRESS_2);
    expect((stored as { accounts: number[] }).accounts).toStrictEqual([
      0, 1, 2,
    ]);
  });

  it('tolerates surrounding whitespace in the query', async () => {
    await submitLookup(`  ${SEP5_ADDRESS_1}  `);
    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0, 1]);
  });

  it('adds nothing when the confirmation is rejected', async () => {
    dialogResponse = false;
    await submitLookup(SEP5_ADDRESS_2);

    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0]);
    expect(updates).toBe(0);
  });

  it('reports an address this recovery phrase does not derive', async () => {
    // A Stellar account from a different phrase cannot be added: the snap
    // holds no key for it and has no import path, so say so plainly.
    await submitLookup(FOREIGN_ADDRESS);

    expect(JSON.stringify(dialogs)).toContain('not derived from this wallet');
    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0]);
    expect(updates).toBe(0);
  });

  it('reports an already-revealed account instead of re-adding it', async () => {
    stored = stateV2({ accounts: [0, 1], origins: CONNECTED });
    await submitLookup(SEP5_ADDRESS_1);

    expect(JSON.stringify(dialogs)).toContain('already in your account list');
    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0, 1]);
    expect(updates).toBe(0);
  });

  it('rejects queries that are neither an address nor an index', async () => {
    for (const query of [
      '',
      '   ',
      'oops',
      '0x2',
      '1e0',
      '-1',
      '2.5',
      'G123',
    ]) {
      await submitLookup(query);
      expect((stored as { accounts: number[] }).accounts).toStrictEqual([0]);
    }
    expect(updates).toBe(0);
  });

  it('refuses an index beyond the account cap', async () => {
    await submitLookup(String(MAX_ACCOUNT_INDEX));

    expect(JSON.stringify(dialogs)).toContain('out of range');
    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0]);
    expect(updates).toBe(0);
  });

  it('ignores form submissions from a form this page does not render', async () => {
    await onUserInput({
      id: 'test-interface',
      event: {
        type: UserInputEventType.FormSubmitEvent,
        name: 'not-our-form',
        value: { 'find-account-query': SEP5_ADDRESS_2 },
      },
      context: null,
    } as never);

    expect(dialogs).toHaveLength(0);
    expect((stored as { accounts: number[] }).accounts).toStrictEqual([0]);
    expect(updates).toBe(0);
  });
});

describe('no pre-version-2 state is accepted', () => {
  it('resets a version-1 state instead of migrating it', async () => {
    const { request } = await install({
      version: 1,
      network: 'TESTNET',
      origins: PRE_DISCLOSURE,
      tokens: {},
    });

    // The migration was removed ahead of the first published release: version 1
    // was never published, so no user store has ever held it. The grant does
    // not survive, which is the point. Carrying it forward would produce a
    // version-2 store with grants and no entropy fingerprint, and that is the
    // one shape `reconcileEntropyBinding` cannot attribute to a secret
    // recovery phrase (src/state/index.ts).
    const address = getResult<{ address: string }>(
      await request({ origin: ORIGIN, method: 'getAddress' }),
    );
    expect(address.address).toBe('');
  }, 45000);
});

describe('disclosure-versioned grants', () => {
  /*
   * A grant records which consent dialog the user actually saw. Account
   * enumeration links every revealed address to the same wallet, so it is
   * only permitted under the disclosure that says so: updating the snap must
   * never hand an already-connected origin a capability it was never shown.
   */

  it('refuses enumeration for a grant predating the disclosure', async () => {
    const { request } = await install(
      stateV2({ accounts: [0, 1, 2], origins: PRE_DISCLOSURE }),
    );

    const error = getError(
      await request({ origin: ORIGIN, method: 'getAccounts' }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('re-confirm');

    // The rest of the original grant still works: the user did consent to
    // the site reading the active address.
    expect(
      getResult<{ address: string }>(
        await request({ origin: ORIGIN, method: 'getAddress' }),
      ).address,
    ).toBe(SEP5_ADDRESS_0);
  }, 45000);

  it('re-prompts a stale grant and restores enumeration on approval', async () => {
    const { request } = await install(
      stateV2({ accounts: [0, 1], origins: PRE_DISCLOSURE }),
    );

    // requestAccess does not return silently for a stale grant: the user is
    // shown the current disclosure again.
    const pending = request({ origin: ORIGIN, method: 'requestAccess' });
    const ui = await pending.getInterface();
    expect(JSON.stringify(ui.content)).toContain('Connect to Stellar');
    await (ui as { ok: () => Promise<void> }).ok();
    await pending;

    const result = getResult<{
      accounts: { index: number; address: string }[];
    }>(await request({ origin: ORIGIN, method: 'getAccounts' }));
    expect(result.accounts).toStrictEqual([
      { index: 0, address: SEP5_ADDRESS_0 },
      { index: 1, address: SEP5_ADDRESS_1 },
    ]);
  }, 45000);

  it('keeps enumeration refused when the re-prompt is rejected', async () => {
    const { request } = await install(
      stateV2({ accounts: [0, 1], origins: PRE_DISCLOSURE }),
    );

    const pending = request({ origin: ORIGIN, method: 'requestAccess' });
    const ui = await pending.getInterface();
    await (ui as { cancel: () => Promise<void> }).cancel();
    expect(getError(await pending).data?.code).toBe(-4);

    expect(
      getError(await request({ origin: ORIGIN, method: 'getAccounts' }))
        .message,
    ).toContain('re-confirm');
  }, 45000);

  it('grants the current disclosure to a newly connected origin', async () => {
    const { request } = await install(stateV2({ accounts: [0, 1] }));

    const pending = request({ origin: ORIGIN, method: 'requestAccess' });
    const ui = await pending.getInterface();
    await (ui as { ok: () => Promise<void> }).ok();
    await pending;

    const result = getResult<{
      accounts: { index: number; address: string }[];
    }>(await request({ origin: ORIGIN, method: 'getAccounts' }));
    expect(result.accounts).toHaveLength(2);
  }, 45000);
});
