import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { SLIP10Node } from '@metamask/key-tree';
import type { Keypair, Transaction, xdr } from '@stellar/stellar-sdk';
import {
  Asset,
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
  deriveSigningKeypair,
  ensureEntropyBinding,
  getAddressForIndex,
  getOwnedAccounts,
  getWalletAddress,
  resetAddressCache,
  resolveSigningAccount,
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

/** Official SEP-0005 test vector 2, for the phrase-change tests. */
const SEP5_MNEMONIC_2 =
  'resource asthma orphan phone ice canvas fire useful arch jewel impose vague theory cushion top';

/** Account 0 of {@link SEP5_MNEMONIC_2}. */
const PHRASE_2_ADDRESS_0 =
  'GAVXVW5MCK7Q66RIBWZZKZEDQTRXWCZUP4DIIFXCCENGW2P6W4OA34RH';

const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ORIGIN = 'https://dapp.example';

let stored: unknown;
let dialogs: unknown[];
let dialogResponse: boolean;
let fetchCalls: string[];
/** When set, `snap_manageState` writes fail while reads keep working. */
let writesFail: boolean;
/** How many times the parent node was fetched, per {@link entropyFetches}. */
let entropyFetches: number;

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

/**
 * Resolves an address straight to a signing keypair, the way the signing
 * handlers do either side of their confirmation dialog.
 *
 * Composed here rather than exported from `../keys`: production splits the two
 * halves so that no account secret is live while a dialog is open, which
 * leaves nothing calling the combined form, and exporting it anyway would ship
 * an uncalled function inside a shasum-sealed signing bundle. The bounded
 * resolution tests below still want the end-to-end path.
 *
 * @param requestedAddress - The SEP-43 `address` option, when one is named.
 * @returns The signing keypair and its account index.
 */
async function resolveSigningKeypair(
  requestedAddress?: string,
): Promise<{ keypair: Keypair; index: number }> {
  const { index, address } = await resolveSigningAccount(requestedAddress);
  return { keypair: await deriveSigningKeypair(index, address), index };
}

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

/**
 * Makes the mocked `snap_getBip32Entropy` answer with the subtree for
 * {@link SEP5_MNEMONIC_2} from now on, without resetting any module cache:
 * the case where MetaMask's primary secret recovery phrase changes while the
 * snap's execution context (and everything it has latched) stays warm.
 * `afterEach` deletes the global, so there is nothing to restore.
 */
async function swapEntropy(): Promise<void> {
  const entropy = await SLIP10Node.fromDerivationPath({
    derivationPath: [`bip39:${SEP5_MNEMONIC_2}`, `slip10:44'`, `slip10:148'`],
    curve: 'ed25519',
  });
  const host = globalThis as unknown as {
    snap: { request: (args: RequestArgs) => Promise<unknown> };
  };
  const real = host.snap.request;
  host.snap.request = async (args: RequestArgs) => {
    if (args.method === 'snap_getBip32Entropy') {
      entropyFetches += 1;
      return entropy.toJSON();
    }
    return real(args);
  };
}

/**
 * Holds the next matching `snap.request` call until released, so a test can
 * suspend one request at a known await point while a second request runs past
 * it. Later matching calls pass through untouched. `afterEach` deletes the
 * global, so there is nothing to restore.
 *
 * Declared at module scope because the match is a conditional, which
 * `jest/no-conditional-in-test` refuses in a test body.
 *
 * @param matches - Which request to hold.
 * @returns `hit`, true once the held call has arrived, and `release`, which
 * lets it proceed.
 */
function gateNextRequest(matches: (args: RequestArgs) => boolean): {
  hit: () => boolean;
  release: () => void;
} {
  const host = globalThis as unknown as {
    snap: { request: (args: RequestArgs) => Promise<unknown> };
  };
  const real = host.snap.request;
  let arrived = false;
  let armed = true;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.snap.request = async (args: RequestArgs) => {
    if (armed && matches(args)) {
      armed = false;
      arrived = true;
      await gate;
    }
    return real(args);
  };
  return { hit: () => arrived, release };
}

/**
 * Matches a persisted-state read, for {@link gateNextRequest}. Declared at
 * module scope because the compound check is a conditional, which
 * `jest/no-conditional-in-test` refuses in a test body.
 *
 * @param args - The intercepted request.
 * @returns True for a `snap_manageState` get.
 */
function isStateRead(args: RequestArgs): boolean {
  return args.method === 'snap_manageState' && args.params.operation === 'get';
}

/**
 * Makes every state write fail, leaving reads working.
 *
 * Models a store the platform will not persist to. That is the condition under
 * which the entropy binding cannot be confirmed, and the snap has to choose
 * between honouring grants it can no longer attribute to a phrase and refusing
 * them.
 *
 * A flag the harness reads, rather than a wrapper around `snap.request`,
 * because {@link restoreStateWrites} has to be able to undo it: a store that
 * fails once and then recovers is the case the recovery test below turns on,
 * and an unwrappable wrapper cannot express it.
 */
function failStateWrites(): void {
  writesFail = true;
}

/** Lets state writes succeed again, modelling a store that recovers. */
function restoreStateWrites(): void {
  writesFail = false;
}

/**
 * Yields event-loop turns until the probe reports true, so a test can hold
 * one in-flight call at a known point (e.g. "its fetch has started") while it
 * drives a second call past it. Each iteration yields a macrotask, not a bare
 * microtask: a microtask-only spin would starve timers and I/O and hang the
 * worker if any awaited step needs them. Declared at module scope because the
 * loop is a conditional, which `jest/no-conditional-in-test` refuses in a
 * test body; a probe that never turns true is caught by the test timeout.
 *
 * @param probe - Returns true once the awaited condition holds.
 */
async function waitUntil(probe: () => boolean): Promise<void> {
  while (!probe()) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** The fetch shape the harness installs on `globalThis`. */
type HarnessFetch = (url: string, init?: unknown) => Promise<unknown>;

/**
 * Wraps the harness fetch so the *first* call hangs until the test rejects it
 * and every later call is served normally. Models a lookup that outlives the
 * balance cache's TTL: the Horizon timeout is twice the window, so a slow
 * failure rejecting after a fresh entry replaced it is a real schedule, and
 * the eviction-identity test below needs to reproduce it deterministically.
 *
 * Declared at module scope because the first-call branch is a conditional,
 * which `jest/no-conditional-in-test` refuses in a test body.
 *
 * @param healthy - The harness fetch to serve every call after the first.
 * @returns The wrapping fetch, a call counter, and the first call's rejecter.
 */
function hangFirstFetch(healthy: HarnessFetch): {
  fetch: HarnessFetch;
  calls: () => number;
  rejectFirst: (error: Error) => void;
} {
  let count = 0;
  let rejectPending: (error: Error) => void = () => undefined;
  const pending = new Promise((_resolve, reject) => {
    rejectPending = reject;
  });
  // The test rejects `pending` deliberately and asserts on the caller's
  // failure; this handler only keeps the fixture's own reference from
  // surfacing as an unhandled rejection.
  pending.catch(() => undefined);
  return {
    fetch: async (url, init) => {
      count += 1;
      return count === 1 ? pending : healthy(url, init);
    },
    calls: () => count,
    rejectFirst: (error) => rejectPending(error),
  };
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
    writesFail = false;
    entropyFetches = 0;
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
            if (writesFail) {
              throw new Error('state unavailable');
            }
            stored = args.params.newState;
            return null;
          case 'snap_getBip32Entropy':
            entropyFetches += 1;
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

  describe('the entropy binding is settled before a grant is honoured', () => {
    /*
     * `reconcileEntropyBinding` runs on first key use, so a handler that reads
     * a grant before deriving anything reads a store whose phrase change has
     * not been noticed yet. That made the reconciliation arrive too late to
     * matter on exactly the paths it was protecting.
     *
     * Both cases below are one `await` each in the handlers, of the kind whose
     * removal reads as a simplification: the tests pass either way unless the
     * store disagrees with the phrase being derived from, which is the only
     * situation the ordering exists for.
     */

    /** A fingerprint that is not the one the mocked entropy produces. */
    const OTHER_PHRASE = 'fingerprint recorded under a different phrase';

    it('getAddress discloses nothing for a grant from another phrase', async () => {
      stored = stateV2({
        origins: CONNECTED,
        entropyFingerprint: OTHER_PHRASE,
      });

      // Deriving is what discovers the mismatch and clears the grants, so
      // checking the grant first meant the very call that revoked it still
      // answered with the new phrase's address.
      expect(await getAddress(ORIGIN)).toStrictEqual({ address: '' });
    });

    it('refuses connected methods for a grant from another phrase', async () => {
      stored = stateV2({
        origins: CONNECTED,
        entropyFingerprint: OTHER_PHRASE,
      });

      await expect(
        setNetwork(ORIGIN, { network: 'FUTURENET' }),
      ).rejects.toThrow('Origin is not connected');
      // `setNetwork` derives nothing on its own, so without the explicit
      // binding step nothing here would ever have detected the change.
      expect(dialogs).toStrictEqual([]);
    });

    it('refuses connected methods when the binding cannot be confirmed', async () => {
      // A store carrying grants but no fingerprint takes the adoption arm,
      // which writes. Failing that write leaves the binding unconfirmed: the
      // snap cannot say which phrase these grants belong to.
      stored = stateV2({ origins: CONNECTED });
      failStateWrites();

      await expect(getBalances(ORIGIN, {})).rejects.toThrow(
        'could not confirm which secret recovery phrase',
      );
      expect(dialogs).toStrictEqual([]);
    });

    it('recovers once the store can be written again', async () => {
      /*
       * The counterpart to the test above, and the one that was missing.
       * Refusing while the binding is unconfirmed is only correct if the
       * refusal ends when the condition does.
       *
       * It did not. `bindToEntropySource` clears its latch on failure so that
       * "the next key use retries it", but `ensureEntropyBinding` reached the
       * retry through `getWalletAddress()`, which reads the address cache
       * first. And the cache is warm exactly here: the failing call clears it
       * and then, by design, carries on deriving and writes the address
       * straight back. So every later call was a cache hit, the parent node
       * was never fetched again, the reconciliation never re-ran, and one
       * transient write failure refused every connected-origin method for the
       * rest of the execution context.
       *
       * The entropy-fetch count is asserted, not just the outcome: it is what
       * distinguishes a real retry from a lucky pass, and it is what would
       * catch a future change routing this back through the cache.
       */
      stored = stateV2({ origins: CONNECTED });
      failStateWrites();

      await expect(getAddress(ORIGIN)).rejects.toThrow(
        'could not confirm which secret recovery phrase',
      );
      const afterRefusal = entropyFetches;

      restoreStateWrites();

      expect(await getAddress(ORIGIN)).toStrictEqual({ address: ADDRESS_0 });
      // The retry has to cross the sandbox boundary again; that fetch is the
      // only thing that runs the reconciliation.
      expect(entropyFetches).toBeGreaterThan(afterRefusal);
      // And the binding it established is now persisted, so the store can be
      // attributed to the phrase being derived from.
      expect(
        (stored as { entropyFingerprint?: string }).entropyFingerprint,
      ).toStrictEqual(expect.any(String));
    });

    it('keeps honouring a grant once the binding is confirmed', async () => {
      // The counterweight to the three above: the fail-closed paths must not
      // fire on an ordinary store, or they would be a denial of service.
      stored = stateV2({ origins: CONNECTED });

      expect(await getAddress(ORIGIN)).toStrictEqual({ address: ADDRESS_0 });
      expect(await getBalances(ORIGIN, {})).toMatchObject({
        address: ADDRESS_0,
      });
    });
  });

  describe('a phrase change within one execution context', () => {
    /*
     * The tests above change the phrase *between* execution contexts: the
     * store carries another fingerprint and the first derivation of a fresh
     * context notices. MetaMask can also change its primary secret recovery
     * phrase while a context stays warm, after the binding has already been
     * verified once. That must not be a quieter case: the verification is
     * per-phrase, not per-context, so the next grant read has to re-derive,
     * notice the new fingerprint, and reset the old phrase's grants and
     * account registry before anything is answered from them.
     */

    it('clears grants recorded under the previous phrase', async () => {
      stored = stateV2({ origins: CONNECTED });

      // Establish and verify the binding for the first phrase.
      expect(await getAddress(ORIGIN)).toStrictEqual({ address: ADDRESS_0 });

      await swapEntropy();

      // The very next grant-gated call observes the change: the grant from
      // the old wallet is reset, not answered with the new wallet's address.
      expect(await getAddress(ORIGIN)).toStrictEqual({ address: '' });
      expect(stored).toMatchObject({
        origins: {},
        resetNotice: 'phrase-changed',
      });
    });

    it('refuses connected methods after the change', async () => {
      stored = stateV2({ origins: CONNECTED });
      expect(await assertConnected(ORIGIN)).toBeUndefined();

      await swapEntropy();

      await expect(
        setNetwork(ORIGIN, { network: 'FUTURENET' }),
      ).rejects.toThrow('Origin is not connected');
      expect(dialogs).toStrictEqual([]);
    });

    it('resolves signing against the reset state, not the old snapshot', async () => {
      stored = stateV2({
        origins: CONNECTED,
        accounts: [0, 1],
        activeAccount: 1,
      });
      const first = await resolveSigningKeypair();
      expect(first.index).toBe(1);
      expect(first.keypair.publicKey()).toBe(ADDRESS_1);

      await swapEntropy();

      // The old registry named index 1 as active; the reset discards that
      // selection, so cold signing must present the new wallet's account 0
      // rather than deriving the stale index under the new phrase.
      const second = await resolveSigningKeypair();
      expect(second.index).toBe(0);
      expect(second.keypair.publicKey()).toBe(PHRASE_2_ADDRESS_0);
      expect(stored).toMatchObject({ activeAccount: 0, accounts: [0] });
    });
  });

  describe('requests overlapping a phrase change', () => {
    /*
     * The tests above change the phrase between sequential calls. Requests
     * also overlap: one can retain a parent node fetched under the old
     * phrase while another observes the new one, clears the address cache,
     * and reconciles the store. The retained work then settles *after* the
     * reconciliation, and its results describe a wallet that is no longer
     * active. Completions like that must be refused, not cached or returned,
     * and an approval collected for the old phrase must not write a grant
     * into the new phrase's state.
     */

    it('a derivation retained across the change cannot repopulate the cache', async () => {
      stored = stateV2({ accounts: [0, 1], activeAccount: 1 });

      // Establish the first phrase's binding without warming the index the
      // held request will derive.
      expect(await getAddressForIndex(0)).toBe(ADDRESS_0);

      // Hold a request between its parent-node fetch (first phrase) and its
      // state read, the window in which its node can be superseded.
      const gate = gateNextRequest(isStateRead);
      const held = ensureEntropyBinding();
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      // A fresh request observes the new phrase: the cache is cleared and
      // the store reconciled (accounts reset, active account back to 0).
      await swapEntropy();
      const fresh = await getAddressForIndex(1);
      expect(fresh).not.toBe(ADDRESS_1);

      // The held request now resumes with a node from the previous phrase.
      // Its completion must be refused: caching the old-phrase address at
      // the reset active index would make every later display answer with
      // an address this wallet no longer holds.
      gate.release();
      await expect(held).rejects.toThrow('secret recovery phrase changed');

      expect(await getWalletAddress()).toBe(PHRASE_2_ADDRESS_0);
      expect(await getAddressForIndex(0)).toBe(PHRASE_2_ADDRESS_0);
    });

    it('an approval spanning the change does not create a grant for the new phrase', async () => {
      stored = stateV2();

      // Hold requestAccess at its open dialog: the address it displays was
      // derived under the first phrase.
      const gate = gateNextRequest((args) => args.method === 'snap_dialog');
      const held = requestAccess(ORIGIN);
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      // The phrase changes while the dialog is open, and a fresh request
      // reconciles the store to the new phrase.
      await swapEntropy();
      await ensureEntropyBinding();

      // The user approves the dialog that showed the old wallet's address.
      // That consent describes the previous wallet, so it must neither
      // record a grant in the new phrase's state nor hand out the address.
      gate.release();
      await expect(held).rejects.toThrow('no longer applies');

      expect(
        (stored as { origins: Record<string, unknown> }).origins,
      ).toStrictEqual({});
      await expect(assertConnected(ORIGIN)).rejects.toThrow(
        'Origin is not connected',
      );
    });
  });

  describe('addToken pre-dialog contract reads are budgeted', () => {
    it('refuses when the token-read budget cannot cover both reads', async () => {
      stored = stateV2({ origins: CONNECTED });
      // One slot short of the reads `addToken` needs (symbol, decimals,
      // name), which is what distinguishes claiming them together from
      // claiming fewer or none.
      expect(takeTokenReadBudget(MAX_TOKEN_READ_LOOKUPS - 1)).toBe(true);

      await expect(addToken(ORIGIN, { contractId: CONTRACT })).rejects.toThrow(
        'Too many token contract reads',
      );
      // The reads happen before any dialog can gate them, so a refusal that
      // prompted first would not be a refusal.
      expect(dialogs).toStrictEqual([]);
      expect(fetchCalls).toStrictEqual([]);
    });

    it('reads and prompts when the budget allows', async () => {
      stored = stateV2({ origins: CONNECTED });

      expect(await addToken(ORIGIN, { contractId: CONTRACT })).toStrictEqual({
        contractId: CONTRACT,
        symbol: 'TEST',
        decimals: 7,
      });
      expect(dialogs).toHaveLength(1);
    });

    it('presents the symbol as self-reported for an ordinary contract', async () => {
      // Any contract may call itself anything; the dialog must say so rather
      // than present the symbol as a fact, and the contract address is the
      // only identity it can vouch for.
      stored = stateV2({ origins: CONNECTED });
      await addToken(ORIGIN, { contractId: CONTRACT });
      const dialog = JSON.stringify(dialogs[0]);
      expect(dialog).toContain('Symbol (self-reported)');
      expect(dialog).toContain('is not verified');
      expect(dialog).not.toContain('Stellar asset (verified)');
    });

    it('names the classic asset when the contract is its Stellar Asset Contract', async () => {
      // The name a contract reports is as forgeable as its symbol, but a
      // `CODE:ISSUER` name is a checkable claim: the SAC address for that
      // asset is derived, and only the contract at that address gets the
      // verified label.
      stored = stateV2({ origins: CONNECTED });
      const asset = new Asset('TEST', ADDRESS_0);
      const sac = asset.contractId(Networks.TESTNET);
      TOKEN_READS.name = nativeToScVal(`TEST:${ADDRESS_0}`, { type: 'string' });
      try {
        await addToken(ORIGIN, { contractId: sac });
      } finally {
        delete TOKEN_READS.name;
      }
      const dialog = JSON.stringify(dialogs[0]);
      expect(dialog).toContain('Stellar asset (verified)');
      expect(dialog).toContain(`TEST:${ADDRESS_0}`);
      expect(dialog).not.toContain('is not verified');
    });

    it('does not verify a contract that merely claims an asset name', async () => {
      stored = stateV2({ origins: CONNECTED });
      TOKEN_READS.name = nativeToScVal(`TEST:${ADDRESS_0}`, { type: 'string' });
      try {
        await addToken(ORIGIN, { contractId: CONTRACT });
      } finally {
        delete TOKEN_READS.name;
      }
      const dialog = JSON.stringify(dialogs[0]);
      expect(dialog).not.toContain('Stellar asset (verified)');
      expect(dialog).toContain('is not verified');
    });

    it('refuses a verified SAC whose reported decimals are not 7', async () => {
      // A Stellar Asset Contract's decimals are fixed at 7 by the protocol,
      // and the value is read by simulation, so a different answer for a
      // contract the snap has verified to BE that asset's SAC can only come
      // from a lying endpoint. `decimals` is the one endpoint answer that
      // persists into state and scales every later balance render, so it
      // must be refused before any dialog can bless it as "verified".
      stored = stateV2({ origins: CONNECTED });
      const asset = new Asset('TEST', ADDRESS_0);
      const sac = asset.contractId(Networks.TESTNET);
      TOKEN_READS.name = nativeToScVal(`TEST:${ADDRESS_0}`, { type: 'string' });
      TOKEN_READS.decimals = nativeToScVal(6, { type: 'u32' });
      try {
        await expect(addToken(ORIGIN, { contractId: sac })).rejects.toThrow(
          'inconsistent with this verified Stellar asset contract',
        );
      } finally {
        delete TOKEN_READS.name;
        TOKEN_READS.decimals = nativeToScVal(7, { type: 'u32' });
      }
      expect(dialogs).toHaveLength(0);
    });

    it('accepts non-7 decimals from a contract that is not a verified SAC', async () => {
      // The positive control for the refusal above: an arbitrary SEP-41
      // token's decimals are its own business, and the check must be scoped
      // to contracts whose decimals the snap can actually derive.
      stored = stateV2({ origins: CONNECTED });
      TOKEN_READS.decimals = nativeToScVal(6, { type: 'u32' });
      try {
        expect(await addToken(ORIGIN, { contractId: CONTRACT })).toStrictEqual({
          contractId: CONTRACT,
          symbol: 'TEST',
          decimals: 6,
        });
      } finally {
        TOKEN_READS.decimals = nativeToScVal(7, { type: 'u32' });
      }
      expect(dialogs).toHaveLength(1);
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
        type: 'soroban',
        contractId: CONTRACT,
      });
    });

    it('marks token rows so a symbol cannot pose as a classic asset code', async () => {
      // A token's symbol is reported by its contract, so a contract the user
      // was persuaded to track can call itself anything. `TEST:C...` and a
      // classic `TEST:G...` differ only in one character of the second field,
      // which a consumer splitting on ':' will not notice. The `type` field
      // and the separate `contractId` are what make the distinction available
      // without parsing the display string.
      const result = await getBalances(ORIGIN, {});
      const classic = result.balances.filter((row) => row.type !== 'soroban');
      const tokens = result.balances.filter((row) => row.type === 'soroban');
      expect(classic).not.toHaveLength(0);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.contractId).toBe(CONTRACT);
      expect(classic.every((row) => row.contractId === undefined)).toBe(true);
    });

    it('marks the omission instead of silently dropping token rows', async () => {
      // Exhausting the budget must not look like "this account holds no
      // tokens": absence of a row and absence of a lookup are different
      // facts, and only the flag distinguishes them.
      expect(takeTokenReadBudget(MAX_TOKEN_READ_LOOKUPS)).toBe(true);
      const result = await getBalances(ORIGIN, {});
      expect(result.tokensUnavailable).toBe(true);
      expect(result.balances).toStrictEqual([
        { asset: 'XLM', balance: '100.0000000', type: 'native' },
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

  describe('balance coalescing cache', () => {
    it('a slow failure does not evict the fresh entry that replaced it', async () => {
      // A lookup can outlive its own 5-second TTL: the Horizon timeout alone
      // is 10 seconds. When it finally rejects, a fresh entry may already sit
      // under the same key, and the failure eviction must recognize that the
      // entry is no longer its own. Deleting by key alone evicted the live
      // entry, so the next call re-ran the whole fan-out for a lookup that
      // had already succeeded.
      stored = stateV2({ origins: CONNECTED });
      const host = globalThis as { fetch?: unknown };
      const healthyFetch = host.fetch as HarnessFetch;
      const { fetch, calls, rejectFirst } = hangFirstFetch(healthyFetch);
      host.fetch = fetch;

      let now = 0;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const first = getBalances(ORIGIN, {});
        first.catch(() => undefined);
        // Hold the first call at its in-flight fetch before starting the
        // second, so the two cannot race for the mock's first-call branch.
        await waitUntil(() => calls() === 1);

        // Past the TTL: the pending entry is stale, so this installs a fresh
        // entry under the same key, served by the healthy fetch.
        now = 6000;
        expect(await getBalances(ORIGIN, {})).toMatchObject({
          address: ADDRESS_0,
        });

        rejectFirst(new Error('network down'));
        await expect(first).rejects.toThrow('Could not reach Horizon');

        // The fresh entry is still within its own window and must be served
        // from cache: a third fan-out would mean the stale failure evicted it.
        expect(await getBalances(ORIGIN, {})).toMatchObject({
          address: ADDRESS_0,
        });
        expect(calls()).toBe(2);
      } finally {
        clock.mockRestore();
        host.fetch = healthyFetch;
      }
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
