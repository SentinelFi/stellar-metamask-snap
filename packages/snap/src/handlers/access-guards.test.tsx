import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SLIP10Node } from '@metamask/key-tree';
import type { Transaction, xdr } from '@stellar/stellar-sdk';
import {
  nativeToScVal,
  Networks,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import { getAddress, requestAccess } from './access';
import {
  addToken,
  assertConnected,
  fund,
  getBalances,
  resetBalanceCache,
} from './account';
import { getAccounts, setActiveAccount } from './accounts';
import { setNetwork } from './network';
import {
  getOwnedAccounts,
  resetAddressCache,
  resolveSigningKeypair,
} from '../keys';
import {
  MAX_TOKEN_READ_LOOKUPS,
  resetRequestLimits,
  takeTokenReadBudget,
} from '../rpc/limiter';
import { resetDialogThrottle } from '../rpc/throttle';

/*
 * Gate tests for the connection boundary and account resolution.
 *
 * `assertConnected` in ./account.tsx is one `if`, and it is the only thing
 * standing between an arbitrary origin and `fund`, `getBalances`, `addToken`,
 * `setNetwork`, `getAccounts`, `setActiveAccount`, and account selection on
 * the signing methods. `resolveSigningKeypair` in ../keys is one `find`, and
 * it is what confines signing to indices the user has revealed. Both are the
 * same shape of risk as the fail-closed guards in ./sign-guards.test.tsx: a
 * deletion widens the snap's exposure and looks like a simplification.
 *
 * They are exercised behaviourally by the simulator suites, but snaps-jest
 * runs the built bundle, so that produces no instrumented coverage of `src`
 * and no coverage threshold could protect either. These tests call the
 * handlers directly against a mocked `snap` global so the thresholds in
 * jest.config.js can.
 *
 * Every gate test asserts on `dialogs` as well as the error: a refusal that
 * happens only after prompting the user is not a refusal, it is a prompt.
 */

/** Official SEP-0005 test vector 1; publicly known, never for real funds. */
const SEP5_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';

/** Accounts 0 and 1 of that vector, derived by the mocked entropy below. */
const ADDRESS_0 = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const ADDRESS_1 = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';

/** An address this wallet does not hold (SEP-0005 vector 2, account 0). */
const FOREIGN = 'GC3MMSXBWHL6CPOAVERSJITX7BH76YU252WGLUOM5CJX3E7UCYZBTPJQ';

const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ORIGIN = 'https://dapp.example';

let stored: unknown;
let dialogs: unknown[];
let dialogResponse: boolean;
let fetchCalls: string[];

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

/** A grant recorded under the current disclosure. */
const CONNECTED = {
  [ORIGIN]: { connectedAt: '2026-08-12T00:00:00Z', disclosureVersion: 1 },
};

/** A grant predating disclosure versioning (migrated from state version 1). */
const CONNECTED_STALE = {
  [ORIGIN]: { connectedAt: '2026-08-12T00:00:00Z' },
};

/**
 * A minimal `Response` for the buffered branch of `readJsonBounded`: no body
 * stream, so it reads `arrayBuffer()` and applies the byte cap afterwards.
 *
 * @param body - The JSON body to return.
 * @param init - Status overrides.
 * @param init.status - The HTTP status code.
 * @returns A response-shaped object.
 */
function jsonResponse(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.from(text, 'utf8'),
  };
}

/** A funded Horizon account response for {@link ADDRESS_0}. */
const HORIZON_ACCOUNT = {
  sequence: '12345',
  // eslint-disable-next-line @typescript-eslint/naming-convention
  balances: [{ asset_type: 'native', balance: '100.0000000' }],
};

/**
 * Wraps an ScVal as the `results[0].xdr` of a simulateTransaction response.
 *
 * @param value - The ScVal the simulated contract call returns.
 * @returns A JSON-RPC response body.
 */
function simulationResult(value: xdr.ScVal) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { results: [{ xdr: value.toXDR('base64') }], latestLedger: 100 },
  };
}

/** What each simulated SEP-41 read returns, by contract function name. */
const TOKEN_READS: Record<string, xdr.ScVal> = {
  symbol: nativeToScVal('TEST', { type: 'symbol' }),
  decimals: nativeToScVal(7, { type: 'u32' }),
  // 1.0000000 at 7 decimals, so a wrong `decimals` cannot render as "1".
  balance: nativeToScVal(10_000_000n, { type: 'i128' }),
};

/**
 * Decodes a simulateTransaction request body and returns the ScVal the named
 * contract function should answer with.
 *
 * @param body - The JSON-RPC request body the client sent.
 * @returns The ScVal to place in the simulation result.
 */
function simulatedReturn(body: unknown): xdr.ScVal {
  const { params } = JSON.parse(String(body)) as {
    params: { transaction: string };
  };
  const tx = TransactionBuilder.fromXDR(params.transaction, Networks.TESTNET);
  const [operation] = (tx as Transaction).operations;
  if (operation?.type !== 'invokeHostFunction') {
    throw new Error(`Unexpected simulated operation: ${operation?.type}`);
  }
  const name = operation.func.invokeContract().functionName().toString();
  const value = TOKEN_READS[name];
  if (!value) {
    throw new Error(`Unexpected simulated contract call: ${name}`);
  }
  return value;
}

type RequestArgs = {
  method: string;
  params: { operation?: string; newState?: unknown };
};

/** A persisted state object as it was handed to `snap_manageState`. */
type StateWrite = {
  origins: Record<string, unknown>;
  entropyFingerprint?: string;
};

/**
 * Wraps the harness `snap.request` so every state write is captured, not just
 * the final one: write *ordering* is the property under test, so an
 * intermediate write pairing a grant with a missing fingerprint has to be
 * visible. `afterEach` deletes the global, so there is nothing to restore.
 *
 * Declared at module scope rather than inside the test because the method
 * check below is a conditional, and `jest/no-conditional-in-test` (rightly)
 * refuses those in a test body.
 *
 * @returns The array that accumulates each written state, in write order.
 */
function captureStateWrites(): StateWrite[] {
  const writes: StateWrite[] = [];
  const host = globalThis as unknown as {
    snap: { request: (args: RequestArgs) => Promise<unknown> };
  };
  const real = host.snap.request;
  host.snap.request = async (args: RequestArgs) => {
    if (args.method === 'snap_manageState' && args.params.operation !== 'get') {
      writes.push(args.params.newState as StateWrite);
    }
    return real(args);
  };
  return writes;
}

describe('connection gate and account resolution', () => {
  beforeEach(async () => {
    const entropy = await SLIP10Node.fromDerivationPath({
      derivationPath: [`bip39:${SEP5_MNEMONIC}`, `slip10:44'`, `slip10:148'`],
      curve: 'ed25519',
    });
    stored = stateV2();
    dialogs = [];
    dialogResponse = true;
    fetchCalls = [];
    // The address cache, the entropy binding, the balance cache, the request
    // limits and the dialog throttle are all module state that outlives a
    // test otherwise.
    resetAddressCache();
    resetBalanceCache();
    resetRequestLimits();
    resetDialogThrottle();

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

    // Every call is recorded, so a gate test can assert that a refusal
    // happened before any outbound request, not merely before a dialog.
    (globalThis as { fetch?: unknown }).fetch = async (
      url: string,
      init?: { method?: string; body?: unknown },
    ) => {
      fetchCalls.push(url);
      await Promise.resolve();
      if (url.includes('friendbot')) {
        return jsonResponse({});
      }
      if (url.includes('/accounts/')) {
        return jsonResponse(HORIZON_ACCOUNT);
      }
      if (init?.method === 'POST') {
        // Answer by the contract function actually being simulated, decoded
        // from the envelope. Answering by call order instead would silently
        // mis-route as soon as a caller stops making the reads in the order
        // the mock assumed, and the resulting failure looks like a bug in the
        // code under test rather than in the fixture.
        return jsonResponse(simulationResult(simulatedReturn(init.body)));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
  });

  afterEach(() => {
    delete (globalThis as { snap?: unknown }).snap;
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  describe('assertConnected', () => {
    it('refuses an origin with no grant', async () => {
      await expect(assertConnected(ORIGIN)).rejects.toThrow(
        'Origin is not connected',
      );
    });

    it('admits an origin holding a grant', async () => {
      stored = stateV2({ origins: CONNECTED });
      expect(await assertConnected(ORIGIN)).toBeUndefined();
    });

    it('is keyed on the exact origin, not a prefix or suffix of it', async () => {
      // A grant for `https://dapp.example` must not carry over to
      // `https://dapp.example.evil.test`, which contains it as a prefix.
      stored = stateV2({ origins: CONNECTED });
      await expect(
        assertConnected('https://dapp.example.evil.test'),
      ).rejects.toThrow('Origin is not connected');
      await expect(assertConnected('https://evil.test')).rejects.toThrow(
        'Origin is not connected',
      );
    });

    it('does not report a phantom grant for a prototype-chain key', async () => {
      // `origins.__proto__` resolves through the prototype chain on a plain
      // object; the lookup must use hasOwnProperty, not indexing.
      stored = stateV2({ origins: {} });
      await expect(assertConnected('__proto__')).rejects.toThrow(
        'Origin is not connected',
      );
      await expect(assertConnected('constructor')).rejects.toThrow(
        'Origin is not connected',
      );
    });
  });

  describe('methods reserved for connected origins', () => {
    /*
     * Table-driven so that adding a connection-gated method without gating it
     * fails here. Each entry is invoked with no grant in state and must reject
     * before opening a dialog or making a request.
     */
    const gated: [string, (origin: string) => Promise<unknown>][] = [
      ['fund', async (origin) => fund(origin, {})],
      ['getBalances', async (origin) => getBalances(origin, {})],
      [
        'addToken',
        async (origin) => addToken(origin, { contractId: CONTRACT }),
      ],
      [
        'setNetwork',
        async (origin) => setNetwork(origin, { network: 'PUBLIC' }),
      ],
      ['getAccounts', async (origin) => getAccounts(origin)],
      [
        'setActiveAccount',
        async (origin) => setActiveAccount(origin, { index: 0 }),
      ],
    ];

    it.each(gated)(
      '%s refuses an unconnected origin before any dialog or request',
      async (_name, call) => {
        await expect(call(ORIGIN)).rejects.toThrow('Origin is not connected');
        expect(dialogs).toHaveLength(0);
        expect(fetchCalls).toHaveLength(0);
      },
    );

    it('admits the same calls once the origin holds a grant', async () => {
      // The positive control: without it, every assertion above would pass if
      // the methods were simply broken.
      stored = stateV2({ origins: CONNECTED });
      expect(await fund(ORIGIN, {})).toStrictEqual({
        funded: true,
        address: ADDRESS_0,
      });
      expect(await getAccounts(ORIGIN)).toStrictEqual({
        accounts: [{ index: 0, address: ADDRESS_0 }],
        activeIndex: 0,
      });
    });
  });

  describe('entropy binding is recorded before any grant', () => {
    /*
     * The invariant `reconcileEntropyBinding` relies on when it adopts a
     * fingerprint that is simply absent (see its doc comment in
     * ../state/index.ts).
     *
     * Adoption assumes the store has never derived a key, so its contents
     * cannot belong to some other secret recovery phrase. That holds only
     * because every path that records a grant derives a key first, which
     * writes the fingerprint. If a future change ever recorded a grant without
     * a preceding derivation, adoption would start silently carrying one
     * wallet's consent onto another's keys, and nothing else in the codebase
     * would notice.
     */

    it('never writes a grant into a store with no fingerprint', async () => {
      const writes = captureStateWrites();

      // A completely fresh store: no fingerprint, no grants.
      stored = stateV2();
      await requestAccess(ORIGIN);

      // The grant landed...
      const grantWrites = writes.filter(
        (write) => Object.keys(write.origins).length > 0,
      );
      expect(grantWrites.length).toBeGreaterThan(0);
      // ...and no write along the way ever paired a grant with a missing
      // fingerprint, which is the state adoption cannot tell apart from a
      // legacy store.
      expect(
        grantWrites.every(
          (write) => typeof write.entropyFingerprint === 'string',
        ),
      ).toBe(true);
    });
  });

  describe('getAccounts disclosure versioning', () => {
    it('refuses a grant recorded before enumeration was disclosed', async () => {
      stored = stateV2({ origins: CONNECTED_STALE });
      await expect(getAccounts(ORIGIN)).rejects.toThrow(
        'connected before account enumeration was disclosed',
      );
      expect(dialogs).toHaveLength(0);
    });

    it('admits it again after requestAccess re-approval', async () => {
      stored = stateV2({ origins: CONNECTED_STALE });
      await requestAccess(ORIGIN);
      expect(dialogs).toHaveLength(1);
      expect(await getAccounts(ORIGIN)).toMatchObject({
        activeIndex: 0,
      });
    });
  });

  describe('requestAccess and getAddress', () => {
    it('getAddress discloses nothing without a grant', async () => {
      expect(await getAddress(ORIGIN)).toStrictEqual({ address: '' });
      expect(dialogs).toHaveLength(0);
    });

    it('getAddress returns the active address with a grant', async () => {
      stored = stateV2({ origins: CONNECTED });
      expect(await getAddress(ORIGIN)).toStrictEqual({
        address: ADDRESS_0,
      });
      expect(dialogs).toHaveLength(0);
    });

    it('requestAccess prompts when unconnected and records the grant', async () => {
      expect(await requestAccess(ORIGIN)).toStrictEqual({
        address: ADDRESS_0,
      });
      expect(dialogs).toHaveLength(1);
      expect(await assertConnected(ORIGIN)).toBeUndefined();
    });

    it('requestAccess throws -4 and records nothing when rejected', async () => {
      dialogResponse = false;
      await expect(requestAccess(ORIGIN)).rejects.toMatchObject({
        data: { code: -4 },
      });
      await expect(assertConnected(ORIGIN)).rejects.toThrow(
        'Origin is not connected',
      );
    });

    it('requestAccess is silent for a grant at the current disclosure', async () => {
      stored = stateV2({ origins: CONNECTED });
      expect(await requestAccess(ORIGIN)).toStrictEqual({
        address: ADDRESS_0,
      });
      expect(dialogs).toHaveLength(0);
    });
  });

  describe('resolveSigningKeypair', () => {
    it('defaults to the active account when no address is named', async () => {
      const { keypair, index } = await resolveSigningKeypair();
      expect(index).toBe(0);
      expect(keypair.publicKey()).toBe(ADDRESS_0);
    });

    it('follows the active account when it changes', async () => {
      stored = stateV2({ accounts: [0, 1], activeAccount: 1 });
      const { keypair, index } = await resolveSigningKeypair();
      expect(index).toBe(1);
      expect(keypair.publicKey()).toBe(ADDRESS_1);
    });

    it('resolves a revealed account named by address', async () => {
      stored = stateV2({ accounts: [0, 1] });
      const { keypair, index } = await resolveSigningKeypair(ADDRESS_1);
      expect(index).toBe(1);
      expect(keypair.publicKey()).toBe(ADDRESS_1);
    });

    it('refuses an address this wallet does not derive', async () => {
      await expect(resolveSigningKeypair(FOREIGN)).rejects.toThrow(
        'this wallet does not hold it',
      );
    });

    it('refuses a derivable account the user has not revealed', async () => {
      // The core of the bounded-resolution claim: account 1 IS derivable from
      // this phrase, and is refused purely because it is absent from the
      // registry. A resolver that swept indices instead of consulting
      // `state.accounts` would pass every other test in this block.
      expect(stateV2().accounts).toStrictEqual([0]);
      await expect(resolveSigningKeypair(ADDRESS_1)).rejects.toThrow(
        'this wallet does not hold it',
      );
    });
  });

  describe('setNetwork', () => {
    beforeEach(() => {
      stored = stateV2({ origins: CONNECTED });
    });

    it('switches only after the user approves', async () => {
      expect(await setNetwork(ORIGIN, { network: 'PUBLIC' })).toMatchObject({
        network: 'PUBLIC',
      });
      expect(dialogs).toHaveLength(1);
      expect(stored).toMatchObject({ network: 'PUBLIC' });
    });

    it('leaves the network unchanged when the user rejects', async () => {
      dialogResponse = false;
      await expect(
        setNetwork(ORIGIN, { network: 'PUBLIC' }),
      ).rejects.toMatchObject({ data: { code: -4 } });
      expect(stored).toMatchObject({ network: 'TESTNET' });
    });

    it('does not prompt when the target is already active', async () => {
      expect(await setNetwork(ORIGIN, { network: 'TESTNET' })).toMatchObject({
        network: 'TESTNET',
      });
      expect(dialogs).toHaveLength(0);
    });

    it('rejects an unknown network before prompting', async () => {
      await expect(
        setNetwork(ORIGIN, { network: 'MAINNET' }),
      ).rejects.toMatchObject({ data: { code: -3 } });
      expect(dialogs).toHaveLength(0);
    });
  });

  describe('setActiveAccount', () => {
    beforeEach(() => {
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
    });

    it('switches to a revealed account after approval', async () => {
      expect(await setActiveAccount(ORIGIN, { index: 1 })).toStrictEqual({
        index: 1,
        address: ADDRESS_1,
      });
      expect(dialogs).toHaveLength(1);
      expect(stored).toMatchObject({ activeAccount: 1 });
    });

    it('leaves the active account unchanged when the user rejects', async () => {
      dialogResponse = false;
      await expect(
        setActiveAccount(ORIGIN, { index: 1 }),
      ).rejects.toMatchObject({ data: { code: -4 } });
      expect(stored).toMatchObject({ activeAccount: 0 });
    });

    it('refuses an index the user has not revealed', async () => {
      // A dapp must not be able to make the wallet derive a new account.
      await expect(setActiveAccount(ORIGIN, { index: 2 })).rejects.toThrow(
        'the user has not added it',
      );
      expect(dialogs).toHaveLength(0);
    });

    it('refuses an out-of-range index at the boundary', async () => {
      await expect(
        setActiveAccount(ORIGIN, { index: 256 }),
      ).rejects.toMatchObject({ data: { code: -3 } });
      await expect(
        setActiveAccount(ORIGIN, { index: -1 }),
      ).rejects.toMatchObject({ data: { code: -3 } });
      expect(dialogs).toHaveLength(0);
    });

    it('does not prompt when the index is already active', async () => {
      expect(await setActiveAccount(ORIGIN, { index: 0 })).toStrictEqual({
        index: 0,
        address: ADDRESS_0,
      });
      expect(dialogs).toHaveLength(0);
    });
  });

  describe('owned-account restriction on fund and getBalances', () => {
    beforeEach(() => {
      stored = stateV2({ origins: CONNECTED });
    });

    it('fund refuses an address outside the wallet', async () => {
      await expect(fund(ORIGIN, { address: FOREIGN })).rejects.toThrow(
        'can only target an account of this wallet',
      );
      expect(fetchCalls).toHaveLength(0);
    });

    it('fund refuses a derivable but unrevealed account', async () => {
      await expect(fund(ORIGIN, { address: ADDRESS_1 })).rejects.toThrow(
        'can only target an account of this wallet',
      );
      expect(fetchCalls).toHaveLength(0);
    });

    it('getBalances refuses an address outside the wallet', async () => {
      await expect(getBalances(ORIGIN, { address: FOREIGN })).rejects.toThrow(
        'can only target an account of this wallet',
      );
      expect(fetchCalls).toHaveLength(0);
    });

    it('getBalances serves a revealed account', async () => {
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
      expect(await getBalances(ORIGIN, { address: ADDRESS_1 })).toMatchObject({
        address: ADDRESS_1,
        funded: true,
      });
    });
  });

  describe('token-read budget', () => {
    beforeEach(() => {
      stored = stateV2({
        origins: CONNECTED,
        tokens: {
          TESTNET: [{ contractId: CONTRACT, symbol: 'TEST', decimals: 7 }],
        },
      });
    });

    it('includes token balances when the budget allows', async () => {
      const result = await getBalances(ORIGIN, {});
      expect(result.tokensUnavailable).toBeUndefined();
      expect(result.balances).toContainEqual({
        asset: `TEST:${CONTRACT}`,
        balance: '1',
      });
    });

    it('marks the omission instead of silently dropping token rows', async () => {
      // Exhausting the budget must not look like "this account holds no
      // tokens": absence of a row and absence of a lookup are different
      // facts, and only the flag distinguishes them.
      expect(takeTokenReadBudget(MAX_TOKEN_READ_LOOKUPS)).toBe(true);
      const result = await getBalances(ORIGIN, {});
      expect(result.tokensUnavailable).toBe(true);
      expect(result.balances).toStrictEqual([
        { asset: 'XLM', balance: '100.0000000' },
      ]);
      // The classic Horizon lookup still ran; only the fan-out was skipped.
      expect(fetchCalls.some((url) => url.includes('/accounts/'))).toBe(true);
      expect(fetchCalls.some((url) => url.includes('soroban'))).toBe(false);
    });

    it('does not claim the budget when no tokens are tracked', async () => {
      stored = stateV2({ origins: CONNECTED });
      resetBalanceCache();
      const result = await getBalances(ORIGIN, {});
      expect(result.tokensUnavailable).toBeUndefined();
      // A zero-token wallet must not burn a slot per call, or a polling dapp
      // would drain a budget it never uses.
      expect(takeTokenReadBudget(MAX_TOKEN_READ_LOOKUPS)).toBe(true);
    });
  });

  describe('getOwnedAccounts', () => {
    it('returns every revealed account with its derived address', async () => {
      stored = stateV2({ accounts: [0, 1] });
      expect(await getOwnedAccounts()).toStrictEqual([
        { index: 0, address: ADDRESS_0 },
        { index: 1, address: ADDRESS_1 },
      ]);
    });

    it('never yields an entry without an address', async () => {
      // Guards the invariant the removed non-null cast used to assume: an
      // address that failed to resolve must not surface as `undefined` in a
      // dapp-facing result.
      stored = stateV2({ accounts: [0, 1] });
      const owned = await getOwnedAccounts();
      for (const entry of owned) {
        expect(typeof entry.address).toBe('string');
        expect(entry.address).toMatch(/^G[A-Z2-7]{55}$/u);
      }
    });
  });
});
