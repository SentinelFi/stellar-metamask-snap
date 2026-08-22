import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { SLIP10Node } from '@metamask/key-tree';
import type { Keypair, Transaction } from '@stellar/stellar-sdk';
import {
  Account,
  Address,
  Asset,
  nativeToScVal,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
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
import { signAuthEntry, signMessage, signTransaction } from './sign';
import {
  deriveSigningKeypair,
  ensureEntropyBinding,
  getActiveAddress,
  getAddressForIndex,
  getOwnedAccounts,
  resetAddressCache,
  resolveSigningAccount,
} from '../keys';
import {
  MAX_TOKEN_READ_LOOKUPS,
  resetRequestLimits,
  takeTokenReadBudget,
} from '../rpc/limiter';
import { resetDialogThrottle } from '../rpc/throttle';

/**
 * The SLIP-10 path node for the account index a `snap_getBip32PublicKey`
 * request names (`m/44'/148'/<index>'`), typed the way key-tree wants it.
 *
 * @param path - The requested BIP-32 path.
 * @returns The hardened account node.
 */
function accountPathNode(path: string[]): `slip10:${number}'` {
  return `slip10:${path[3] ?? ''}` as `slip10:${number}'`;
}

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

/** The entropy source holding {@link SEP5_MNEMONIC}. */
const SOURCE_A = 'phrase-a';
/** The entropy source holding {@link SEP5_MNEMONIC_2}. */
const SOURCE_B = 'phrase-b';

let stored: unknown;
let dialogs: unknown[];
let dialogResponse: boolean;
let fetchCalls: string[];
/** When set, `snap_manageState` writes fail while reads keep working. */
let writesFail: boolean;
/**
 * How many times key material was requested from the platform: the private
 * subtree (`snap_getBip32Entropy`) or a public key (`snap_getBip32PublicKey`).
 */
let entropyFetches: number;
/** How many of those were observations of the subtree's own public key. */
let subtreeFetches: number;
/** How many were requests for one account's public key. */
let accountKeyFetches: number;
/** How many imported the private subtree (`snap_getBip32Entropy`). */
let privateKeyFetches: number;
/**
 * When set, the platform changes its primary source to {@link SOURCE_B} while
 * serving the next subtree-key request, modelling a user switching phrases in
 * the interval between an observation reading the primary source and its
 * source-bound key request coming back.
 */
let flipDuringNextSubtreeKey: boolean;
/**
 * The `m/44'/148'` subtree of each entropy source the mocked platform holds.
 *
 * Two sources, because that is what a MetaMask holding two secret recovery
 * phrases has. Switching the primary phrase changes *which source is
 * primary*; it does not change what a given source derives. Modelling it that
 * way is what lets these tests tell a key that came from the source a request
 * named apart from one that came from "whichever phrase happened to be
 * primary when the platform answered".
 */
const sourceNodes = new Map<string, SLIP10Node>();
/** The source the mocked platform currently reports as primary. */
let primarySource: string;

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

/**
 * The ledger height both sources report. They agree, so an entry carrying no
 * expiration of its own gets the default lifetime rather than a refusal.
 */
const LATEST_LEDGER = 50_000_000;

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
  return {
    keypair: await deriveSigningKeypair(index, address, primarySource),
    index,
  };
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
 */
function swapEntropy(): void {
  primarySource = SOURCE_B;
}

/** Switches the primary phrase back to {@link SEP5_MNEMONIC}. */
function restoreEntropy(): void {
  primarySource = SOURCE_A;
}

/**
 * The subtree a key request resolves against: the source it named, or the
 * primary one when it named none.
 *
 * @param source - The `source` parameter of the request, when present.
 * @returns The subtree node.
 */
function nodeForSource(source: string | undefined): SLIP10Node {
  const node = sourceNodes.get(source ?? primarySource);
  if (!node) {
    throw new Error(`Entropy source with ID "${String(source)}" not found.`);
  }
  return node;
}

/**
 * Arms a single account-key response to be served from another source,
 * modelling the platform answering one request from a batch while a different
 * phrase was momentarily primary.
 *
 * It applies only to a request that names *no* source, which is the whole
 * point: an unsourced request means "whatever is primary when you serve
 * this", so its answer can come from a phrase the caller never asked for. A
 * request that names its source is served from that source, because that is
 * what naming it buys.
 */
let mixedResponseSource: string | null = null;

/**
 * Arms the platform to change its primary source while it serves the next
 * subtree-key request.
 */
function flipSourceDuringNextSubtreeKey(): void {
  flipDuringNextSubtreeKey = true;
}

/**
 * Matches a subtree-key request, the one an entropy observation makes between
 * its two reads of the primary source.
 *
 * @param args - The intercepted request.
 * @returns True for a `snap_getBip32PublicKey` call naming the subtree.
 */
function isSubtreeKeyFetch(args: RequestArgs): boolean {
  return (
    args.method === 'snap_getBip32PublicKey' &&
    (args.params as { path?: string[] }).path?.length === 3
  );
}

/**
 * Arms {@link mixedResponseSource} for the next unsourced account key.
 *
 * @param source - The source that request should be answered from.
 */
function answerNextUnsourcedKeyFrom(source: string): void {
  mixedResponseSource = source;
}

/**
 * The list the mocked `snap_listEntropySources` answers with.
 *
 * @returns Both sources, with the primary one flagged.
 */
function entropySources() {
  return [SOURCE_A, SOURCE_B].map((id) => ({
    id,
    name: id,
    type: 'mnemonic',
    primary: id === primarySource,
  }));
}

/**
 * Holds a matching `snap.request` call until released, so a test can suspend
 * one request at a known await point while a second request runs past it.
 * Later matching calls pass through untouched. `afterEach` deletes the
 * global, so there is nothing to restore.
 *
 * Declared at module scope because the match is a conditional, which
 * `jest/no-conditional-in-test` refuses in a test body.
 *
 * @param matches - Which request to hold.
 * @param skip - How many matching calls to let through before holding one,
 * so a request can be suspended at, say, its third state read.
 * @returns `hit`, true once the held call has arrived, and `release`, which
 * lets it proceed.
 */
function gateNextRequest(
  matches: (args: RequestArgs) => boolean,
  skip = 0,
): {
  hit: () => boolean;
  release: () => void;
} {
  const host = globalThis as unknown as {
    snap: { request: (args: RequestArgs) => Promise<unknown> };
  };
  const real = host.snap.request;
  let remaining = skip;
  let arrived = false;
  let armed = true;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.snap.request = async (args: RequestArgs) => {
    if (armed && matches(args)) {
      if (remaining > 0) {
        remaining -= 1;
      } else {
        armed = false;
        arrived = true;
        await gate;
      }
    }
    return real(args);
  };
  return { hit: () => arrived, release };
}

/**
 * The `fetch` counterpart of {@link gateNextRequest}: holds the next outbound
 * request whose URL matches, so a handler can be suspended in the middle of
 * a network lookup.
 *
 * @param matches - Which URL to hold.
 * @returns `hit` and `release`, as for {@link gateNextRequest}.
 */
function gateNextFetch(matches: (url: string) => boolean): {
  hit: () => boolean;
  release: () => void;
} {
  const host = globalThis as unknown as {
    fetch: (url: string, init?: unknown) => Promise<unknown>;
  };
  const real = host.fetch;
  let arrived = false;
  let armed = true;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.fetch = async (url: string, init?: unknown) => {
    if (armed && matches(url)) {
      armed = false;
      arrived = true;
      await gate;
    }
    return real(url, init);
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
 * Matches the public-key request for one account (a path one level below
 * the subtree), for {@link gateNextRequest}: the request a handler makes to
 * resolve an address that is not yet memoized.
 *
 * @param args - The intercepted request.
 * @returns True for a `snap_getBip32PublicKey` call naming an account.
 */
function isAccountKeyFetch(args: RequestArgs): boolean {
  return (
    args.method === 'snap_getBip32PublicKey' &&
    (args.params as { path?: string[] }).path?.length === 4
  );
}

/**
 * A classic payment from account 0, for the signing schedules below. Built
 * fresh per call so each method signs its own envelope.
 *
 * @returns The envelope XDR.
 */
function classicPaymentXdr(): string {
  return new TransactionBuilder(new Account(ADDRESS_0, '1'), {
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
    .build()
    .toXDR();
}

/**
 * An address-credential authorization entry naming the given account, so
 * `signAuthEntry` resolves that account the way an explicit `address` option
 * does on the other signing methods.
 *
 * @param address - The authorizing account.
 * @returns The entry's base64 XDR.
 */
function addressAuthEntryXdr(address: string): string {
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
  }).toXDR('base64');
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
  // Bounded on purpose. A condition that never arrives, a gate armed on a
  // request the code under test turns out not to make, would otherwise spin
  // this loop forever, and a loop that keeps yielding starves the runner's
  // own per-test timeout, so the whole suite hangs with nothing named.
  // Failing here names the gate instead.
  const deadline = Date.now() + 5000;
  while (!probe()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil: the awaited condition never arrived');
    }
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
    subtreeFetches = 0;
    accountKeyFetches = 0;
    privateKeyFetches = 0;
    flipDuringNextSubtreeKey = false;
    mixedResponseSource = null;
    sourceNodes.set(SOURCE_A, entropy);
    sourceNodes.set(
      SOURCE_B,
      await SLIP10Node.fromDerivationPath({
        derivationPath: [
          `bip39:${SEP5_MNEMONIC_2}`,
          `slip10:44'`,
          `slip10:148'`,
        ],
        curve: 'ed25519',
      }),
    );
    primarySource = SOURCE_A;
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
        params: {
          operation?: string;
          newState?: unknown;
          content?: unknown;
          path?: string[];
          source?: string;
        };
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
          case 'snap_listEntropySources':
            return entropySources();
          case 'snap_getBip32Entropy':
            entropyFetches += 1;
            privateKeyFetches += 1;
            return nodeForSource(args.params.source).toJSON();
          case 'snap_getBip32PublicKey': {
            // The subtree's own key, or the hardened account one level below,
            // from the source the request named (or the primary one when it
            // named none, which is what an unsourced request would get).
            entropyFetches += 1;
            const path = args.params.path ?? [];
            if (path.length === 3) {
              subtreeFetches += 1;
              // The answer comes from the source the request named, and the
              // switch lands after it: the key is correctly A's, and the
              // wallet is B by the time anyone can look again.
              const subtreeKey = nodeForSource(args.params.source).publicKey;
              if (flipDuringNextSubtreeKey) {
                flipDuringNextSubtreeKey = false;
                primarySource = SOURCE_B;
              }
              return subtreeKey;
            }
            accountKeyFetches += 1;
            // An unsourced account key can be answered from whichever phrase
            // is primary at the instant the platform serves it; a sourced one
            // cannot.
            let accountSource = args.params.source;
            if (accountSource === undefined && mixedResponseSource !== null) {
              accountSource = mixedResponseSource;
              mixedResponseSource = null;
            }
            return (
              await nodeForSource(accountSource).derive([accountPathNode(path)])
            ).publicKey;
          }
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
      // Horizon's root, the second of the two ledger-height sources. Signing
      // an authorization entry requires both to answer and takes the lower
      // height, so a harness that served only one would make every such
      // request fail closed before it ever reached a dialog.
      if (url.endsWith('/')) {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        return jsonResponse({ core_latest_ledger: LATEST_LEDGER });
      }
      if (init?.method === 'POST') {
        if (String(init.body).includes('"getLatestLedger"')) {
          return jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            result: { sequence: LATEST_LEDGER },
          });
        }
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

    it('admits an origin holding a grant, returning the binding it verified', async () => {
      stored = stateV2({ origins: CONNECTED });
      const binding = await assertConnected(ORIGIN);
      expect(binding.fingerprint).toStrictEqual(expect.any(String));
      // The snapshot is the one the grant was read from, and it carries the
      // fingerprint the grant was verified against.
      expect(binding.state.entropyFingerprint).toBe(binding.fingerprint);
      expect(Object.keys(binding.state.origins)).toStrictEqual([ORIGIN]);
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

      swapEntropy();

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
      expect(await assertConnected(ORIGIN)).toMatchObject({
        fingerprint: expect.any(String),
      });

      swapEntropy();

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

      swapEntropy();

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

    it('an address fetched across the change is neither cached nor returned', async () => {
      stored = stateV2({ accounts: [0, 1], activeAccount: 1 });

      // Establish the first phrase's binding. This warms the active index
      // (1) and leaves index 0, which the held request will be made to
      // resolve, cold.
      const first = await ensureEntropyBinding();
      expect(await getActiveAddress(first)).toBe(ADDRESS_1);

      // Hold a cold-signing resolution between its observation of the phrase
      // (the first one) and its state read: the window in which the phrase
      // it observed can be superseded while it still resolves under it.
      const gate = gateNextRequest(isStateRead);
      const held = resolveSigningAccount();
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      // A fresh request observes the new phrase: the cache is cleared and
      // the store reconciled (accounts reset, active account back to 0).
      swapEntropy();
      const second = await ensureEntropyBinding();
      expect(second.state).toMatchObject({ accounts: [0], activeAccount: 0 });
      expect(await getAddressForIndex(second, 1)).not.toBe(ADDRESS_1);

      // The held request now reads the reset store (active account 0) and
      // fetches that index's key, which the platform answers for the phrase
      // that is primary *now*. The confirming observation after the fetch
      // no longer matches the phrase the request resolves under, so the
      // completion must be refused: caching that address under the old
      // phrase, or returning it, would be answering one wallet's request
      // with the other wallet's account.
      gate.release();
      await expect(held).rejects.toThrow('secret recovery phrase changed');

      const current = await ensureEntropyBinding();
      expect(await getActiveAddress(current)).toBe(PHRASE_2_ADDRESS_0);
      expect(await getAddressForIndex(current, 0)).toBe(PHRASE_2_ADDRESS_0);
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
      swapEntropy();
      await ensureEntropyBinding();

      // The user approves the dialog that showed the old wallet's address.
      // That consent describes the previous wallet, so it must neither
      // record a grant in the new phrase's state nor hand out the address.
      gate.release();
      // Refused at the fresh observation the approval now takes, before the
      // grant write is even attempted.
      await expect(held).rejects.toThrow('secret recovery phrase changed');

      expect(
        (stored as { origins: Record<string, unknown> }).origins,
      ).toStrictEqual({});
      await expect(assertConnected(ORIGIN)).rejects.toThrow(
        'Origin is not connected',
      );
    });
  });

  describe('handler work after the grant check stays bound to the phrase that passed it', () => {
    /*
     * The grant check is one moment; the handler's work after it is not. A
     * concurrent request can observe a changed secret recovery phrase and
     * reconcile the store to the new wallet between that check and the
     * handler's later reads, derivations, and writes. A boolean gate would
     * let the handler carry on: read the new wallet's active account, derive
     * its address, fund it, or enumerate it, all under consent given for the
     * old one, and an explicit-address signing request would compare its
     * address against the new wallet's registry, turning a grant for the old
     * wallet into a membership probe of the new.
     *
     * Each schedule below holds a connected method just past its final grant
     * check, lets a second request reconcile the store to the new phrase,
     * then releases the first and asserts that it fails closed: nothing of
     * the new wallet is disclosed, no side effect lands, and the new phrase's
     * state is left exactly as the reconciliation wrote it.
     */

    /** What the store looks like once reconciled to the second phrase. */
    const PHRASE_2_STORE = {
      accounts: [0],
      activeAccount: 0,
      origins: {},
      network: 'TESTNET',
      resetNotice: 'phrase-changed',
    };

    /**
     * Changes the phrase and lets a fresh request reconcile the store to it
     * while the held request stays suspended.
     */
    async function reconcileToPhraseTwo(): Promise<void> {
      swapEntropy();
      const binding = await ensureEntropyBinding();
      expect(binding.state).toMatchObject({ accounts: [0], origins: {} });
    }

    it('getBalances does not disclose once the phrase changed during its lookup', async () => {
      stored = stateV2({ origins: CONNECTED });
      // Held inside the Horizon lookup: the grant check has passed and the
      // address is resolved, and the only thing left is to hand back data.
      const gate = gateNextFetch((url) => url.includes('/accounts/'));
      const held = getBalances(ORIGIN, {});
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      await reconcileToPhraseTwo();

      gate.release();
      await expect(held).rejects.toThrow('secret recovery phrase changed');
      expect(stored).toMatchObject(PHRASE_2_STORE);
    });

    it('fund refuses before friendbot once the phrase changed', async () => {
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
      // Held at the public-key request that resolving the named account
      // needs: the first account key is the grant check's own (the active
      // account), the second is the handler's work after it.
      const gate = gateNextRequest(isAccountKeyFetch, 1);
      const held = fund(ORIGIN, { address: ADDRESS_1 });
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      await reconcileToPhraseTwo();

      gate.release();
      await expect(held).rejects.toThrow('secret recovery phrase changed');
      expect(fetchCalls.some((url) => url.includes('friendbot'))).toBe(false);
      expect(stored).toMatchObject(PHRASE_2_STORE);
    });

    it('getAccounts does not enumerate the new wallet', async () => {
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
      const gate = gateNextRequest(isAccountKeyFetch, 1);
      const held = getAccounts(ORIGIN);
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      await reconcileToPhraseTwo();

      gate.release();
      await expect(held).rejects.toThrow('secret recovery phrase changed');
      expect(stored).toMatchObject(PHRASE_2_STORE);
    });

    it('getAddress refuses a snapshot that belongs to the new phrase', async () => {
      stored = stateV2({ origins: CONNECTED });
      // Held at the binding's own snapshot read: the grant read and the
      // reconciliation's read come first. A snapshot read after the store
      // was reconciled to another phrase carries that phrase's fingerprint,
      // and a grant read out of it would be the new wallet's.
      const gate = gateNextRequest(isStateRead, 2);
      const held = getAddress(ORIGIN);
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      await reconcileToPhraseTwo();

      gate.release();
      await expect(held).rejects.toThrow('secret recovery phrase changed');
      expect(stored).toMatchObject(PHRASE_2_STORE);
    });

    const approvedAfterChange: [string, () => Promise<unknown>][] = [
      ['setNetwork', async () => setNetwork(ORIGIN, { network: 'FUTURENET' })],
      ['setActiveAccount', async () => setActiveAccount(ORIGIN, { index: 1 })],
      ['addToken', async () => addToken(ORIGIN, { contractId: CONTRACT })],
    ];

    it.each(approvedAfterChange)(
      '%s does not commit an approval collected before the change',
      async (_name, call) => {
        stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
        const gate = gateNextRequest((args) => args.method === 'snap_dialog');
        const held = call();
        held.catch(() => undefined);
        await waitUntil(gate.hit);

        await reconcileToPhraseTwo();

        // The user approves a dialog that described the previous wallet.
        // The commit compares the fingerprint inside the state lock and
        // refuses; the new phrase's store is untouched.
        gate.release();
        await expect(held).rejects.toThrow('secret recovery phrase changed');
        expect(stored).toMatchObject(PHRASE_2_STORE);
        expect(JSON.stringify(stored)).not.toContain(CONTRACT);
      },
    );

    const explicitAddressSigners: [
      string,
      (address: string) => Promise<unknown>,
    ][] = [
      [
        'signTransaction',
        async (address) =>
          signTransaction(ORIGIN, { xdr: classicPaymentXdr(), address }),
      ],
      [
        'signMessage',
        async (address) => signMessage(ORIGIN, { message: 'hello', address }),
      ],
      [
        'signAuthEntry',
        async (address) =>
          signAuthEntry(ORIGIN, { authEntry: addressAuthEntryXdr(address) }),
      ],
    ];

    /**
     * Runs one explicit-address signing request across the phrase change and
     * returns how it was refused.
     *
     * @param call - The signing method under test.
     * @param address - The address it names.
     * @returns The refusal message.
     */
    async function refusalAcrossChange(
      call: (address: string) => Promise<unknown>,
      address: string,
    ): Promise<string> {
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
      restoreEntropy();
      resetAddressCache();
      // Held at the account public-key request resolution makes after the
      // grant check's own.
      const gate = gateNextRequest(isAccountKeyFetch, 1);
      const held = call(address);
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      await reconcileToPhraseTwo();

      gate.release();
      return held.then(
        () => 'resolved',
        (error: Error) => error.message,
      );
    }

    it.each(explicitAddressSigners)(
      '%s refuses an address the new wallet holds exactly as it refuses one it does not',
      async (_name, call) => {
        // An origin granted under the old phrase names the new wallet's
        // account 0, then an address no wallet here holds. Before the dialog,
        // the two must be indistinguishable: a different answer would tell
        // the origin which addresses the new wallet holds.
        const owned = await refusalAcrossChange(call, PHRASE_2_ADDRESS_0);
        const foreign = await refusalAcrossChange(call, FOREIGN);
        expect(owned).toContain('secret recovery phrase changed');
        expect(foreign).toBe(owned);
        expect(dialogs).toHaveLength(0);
      },
    );

    it('an older reconciliation cannot vouch for a later period of the same phrase', async () => {
      // A phrase can change from one to another and back while the first
      // phrase's reconciliation is still in flight. That reconciliation then
      // settles having found a store that belonged to the phrase, but two
      // later reconciliations are queued behind it, and the store the second
      // period of the phrase will actually have is the one *they* produce.
      // A latch keyed on the fingerprint alone would let the older
      // completion mark the binding verified for the newer period.
      stored = stateV2({ origins: CONNECTED });
      // Persist the first phrase's fingerprint, then forget it in-context so
      // the next binding reconciles afresh.
      await ensureEntropyBinding();
      resetAddressCache();

      // Hold the first request inside its reconciliation's state read (the
      // grant read comes first).
      const gate = gateNextRequest(isStateRead, 1);
      const held = getAddress(ORIGIN);
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      // The phrase changes away and back while it is held; each change
      // queues its own reconciliation behind the held one.
      // Each binding observes the subtree's public key once on entry; the
      // counts below wait for that observation to have been answered, which
      // is what queues the reconciliation behind the held one.
      swapEntropy();
      const second = ensureEntropyBinding();
      second.catch(() => undefined);
      await waitUntil(() => subtreeFetches >= 4);
      restoreEntropy();
      const third = ensureEntropyBinding();
      third.catch(() => undefined);
      await waitUntil(() => subtreeFetches >= 5);

      gate.release();
      // The held request's reconciliation settles first, and for its
      // fingerprint, but it no longer holds the ticket: the request must not
      // be answered on its strength.
      await expect(held).rejects.toThrow('could not confirm');
      // The request for the other phrase is superseded in turn.
      await expect(second).rejects.toThrow('secret recovery phrase changed');
      // Only the reconciliation that was started for the phrase's second
      // period vouches for it, and the store it produced carries no grant.
      const binding = await third;
      expect(binding.state.origins).toStrictEqual({});
      expect(await getAddress(ORIGIN)).toStrictEqual({ address: '' });
    });
  });

  describe('a phrase switch that no other request observes', () => {
    /*
     * The interval this covers is the one an in-context check cannot see. A
     * user opens a confirmation, switches MetaMask's primary secret recovery
     * phrase while it is open, and approves. If no overlapping request runs in
     * that window, nothing has observed the change: the persisted fingerprint
     * still names the phrase the request began under, so a commit that only
     * compares the approval's fingerprint against the store compares the old
     * value with itself and succeeds.
     *
     * That matters most for the state a reconciliation deliberately keeps. The
     * network preference and the tracked-token registry survive a phrase
     * change by design, so a write made under the stale approval would persist
     * into the new wallet under consent collected for the previous one, and no
     * later reset would undo it.
     *
     * Every case below therefore switches the phrase with `swapEntropy()` and
     * runs no other request before releasing the dialog.
     */

    /** The state a phrase-B store holds once the switch is reconciled. */
    const PHRASE_B_STORE = {
      accounts: [0],
      activeAccount: 0,
      origins: {},
      resetNotice: 'phrase-changed',
    };

    it('setNetwork does not carry the network choice into the new wallet', async () => {
      stored = stateV2({ origins: CONNECTED, network: 'TESTNET' });
      const gate = gateNextRequest((args) => args.method === 'snap_dialog');
      const held = setNetwork(ORIGIN, { network: 'PUBLIC' });
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      // Nothing else runs: the switch is unobserved when the user approves.
      swapEntropy();
      gate.release();

      await expect(held).rejects.toThrow('secret recovery phrase changed');
      // The network preference survives reconciliation, so this is exactly
      // the write that would have persisted into phrase B.
      expect(stored).toMatchObject({ network: 'TESTNET', ...PHRASE_B_STORE });
    });

    it('addToken does not carry the token into the new wallet', async () => {
      stored = stateV2({ origins: CONNECTED });
      const gate = gateNextRequest((args) => args.method === 'snap_dialog');
      const held = addToken(ORIGIN, { contractId: CONTRACT });
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      swapEntropy();
      gate.release();

      await expect(held).rejects.toThrow('secret recovery phrase changed');
      // The token registry survives reconciliation too.
      expect(JSON.stringify(stored)).not.toContain(CONTRACT);
      expect(stored).toMatchObject(PHRASE_B_STORE);
    });

    it('setActiveAccount does not activate an index in the new wallet', async () => {
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
      const gate = gateNextRequest((args) => args.method === 'snap_dialog');
      const held = setActiveAccount(ORIGIN, { index: 1 });
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      swapEntropy();
      gate.release();

      await expect(held).rejects.toThrow('secret recovery phrase changed');
      expect(stored).toMatchObject(PHRASE_B_STORE);
    });

    it('requestAccess does not grant the new wallet to the origin', async () => {
      stored = stateV2();
      const gate = gateNextRequest((args) => args.method === 'snap_dialog');
      const held = requestAccess(ORIGIN);
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      swapEntropy();
      gate.release();

      await expect(held).rejects.toThrow('secret recovery phrase changed');
      expect(
        (stored as { origins: Record<string, unknown> }).origins,
      ).toStrictEqual({});
    });

    it('fund does not reach friendbot for the new wallet', async () => {
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
      // `fund` shows no dialog, so it is held at the account key it resolves
      // after the grant check: the window before its outward side effect.
      // The named account is the non-active one, so resolving it is a real
      // fetch rather than a hit on what the binding already cached.
      const gate = gateNextRequest(isAccountKeyFetch, 1);
      const held = fund(ORIGIN, { address: ADDRESS_1 });
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      swapEntropy();
      gate.release();

      await expect(held).rejects.toThrow('secret recovery phrase changed');
      expect(fetchCalls.some((url) => url.includes('friendbot'))).toBe(false);
    });

    it('getBalances refuses to disclose after an unobserved switch', async () => {
      // The disclosure counterpart. Held inside the Horizon lookup, which is
      // the window a read path actually has, and the switch is seen by
      // nobody: comparing against the last phrase some request observed would
      // still read phrase A and hand the balances over. The answer describes
      // a wallet the user has stopped using, and the origin cannot tell.
      stored = stateV2({ origins: CONNECTED });
      const gate = gateNextFetch((url) => url.includes('/accounts/'));
      const held = getBalances(ORIGIN, {});
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      swapEntropy();
      gate.release();

      await expect(held).rejects.toThrow('secret recovery phrase changed');
    });

    it('the positive control: the same flows commit when the phrase holds', async () => {
      // Without this, every assertion above would pass on a handler that
      // simply refused everything.
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
      expect(await setNetwork(ORIGIN, { network: 'PUBLIC' })).toMatchObject({
        network: 'PUBLIC',
      });
      expect(stored).toMatchObject({ network: 'PUBLIC' });
      expect(await setActiveAccount(ORIGIN, { index: 1 })).toStrictEqual({
        index: 1,
        address: ADDRESS_1,
      });
      expect(stored).toMatchObject({ activeAccount: 1 });
    });
  });

  describe('a phrase switch inside an entropy observation', () => {
    /*
     * Naming the source on a key request makes the answer attributable: the
     * key that comes back is the named phrase's, whatever is primary when the
     * platform serves it. It does not make the answer *authoritative*. The
     * user can change which phrase is primary in the interval between an
     * observation reading the primary source and its key request returning,
     * and a key correctly returned from the former phrase says nothing about
     * which wallet is now in use.
     *
     * The harness models exactly that: `flipSourceDuringNextSubtreeKey()`
     * makes the platform answer the request from the source it named and
     * change its primary to the other phrase in the same breath. An
     * observation that only names a source accepts it; one that reads the
     * primary source again afterwards does not.
     */

    it('refuses to admit a request whose phrase changed under it', async () => {
      stored = stateV2({ origins: CONNECTED });
      flipSourceDuringNextSubtreeKey();
      await expect(getBalances(ORIGIN, {})).rejects.toThrow(
        'secret recovery phrase changed',
      );
    });

    it('does not commit a network change for the phrase that replaced it', async () => {
      stored = stateV2({ origins: CONNECTED, network: 'TESTNET' });
      const gate = gateNextRequest((args) => args.method === 'snap_dialog');
      const held = setNetwork(ORIGIN, { network: 'PUBLIC' });
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      // Armed while the dialog is open, so the switch happens inside the
      // observation the approval triggers rather than before it.
      flipSourceDuringNextSubtreeKey();
      gate.release();

      await expect(held).rejects.toThrow('secret recovery phrase changed');
      // The network preference is one of the two things a reconciliation
      // keeps, so a write here would have followed the user to the new
      // wallet with no later reset to undo it.
      expect(stored).toMatchObject({ network: 'TESTNET' });
    });

    it('does not track a token for the phrase that replaced it', async () => {
      stored = stateV2({ origins: CONNECTED });
      const gate = gateNextRequest((args) => args.method === 'snap_dialog');
      const held = addToken(ORIGIN, { contractId: CONTRACT });
      held.catch(() => undefined);
      await waitUntil(gate.hit);

      flipSourceDuringNextSubtreeKey();
      gate.release();

      await expect(held).rejects.toThrow('secret recovery phrase changed');
      expect(JSON.stringify(stored)).not.toContain(CONTRACT);
    });

    const signers: [string, () => Promise<unknown>][] = [
      [
        'signTransaction',
        async () =>
          signTransaction(ORIGIN, {
            xdr: classicPaymentXdr(),
            address: ADDRESS_1,
          }),
      ],
      [
        'signMessage',
        async () =>
          signMessage(ORIGIN, { message: 'hello', address: ADDRESS_1 }),
      ],
      [
        'signAuthEntry',
        async () =>
          signAuthEntry(ORIGIN, { authEntry: addressAuthEntryXdr(ADDRESS_1) }),
      ],
    ];

    it.each(signers)(
      '%s imports no private key once the phrase has changed',
      async (_name, call) => {
        stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
        const gate = gateNextRequest((args) => args.method === 'snap_dialog');
        const held = call();
        held.catch(() => undefined);
        await waitUntil(gate.hit);

        flipSourceDuringNextSubtreeKey();
        gate.release();

        await expect(held).rejects.toThrow('secret recovery phrase changed');
        // The refusal has to come before the private subtree is imported:
        // deriving first and comparing afterwards would put key material in
        // the sandbox for a wallet the user is no longer using.
        expect(privateKeyFetches).toBe(0);
      },
    );

    it('refuses an address batch and caches nothing from it', async () => {
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
      const binding = await ensureEntropyBinding();
      const before = accountKeyFetches;

      // The batch's own closing observation is the next subtree key.
      flipSourceDuringNextSubtreeKey();
      await expect(getOwnedAccounts(binding)).rejects.toThrow(
        'secret recovery phrase changed',
      );
      expect(accountKeyFetches).toBeGreaterThan(before);

      // Nothing from the refused batch reached the memo: resolving the same
      // account again has to fetch its key again.
      restoreEntropy();
      const afterRefusal = accountKeyFetches;
      expect(
        await getOwnedAccounts(await ensureEntropyBinding()),
      ).toStrictEqual([
        { index: 0, address: ADDRESS_0 },
        { index: 1, address: ADDRESS_1 },
      ]);
      expect(accountKeyFetches).toBeGreaterThan(afterRefusal);
    });

    it('a late observation of the former phrase cannot roll the store back', async () => {
      // Reconciliation is queued in call order, not in the order the switches
      // happened. An observation that started before a switch and returns
      // after one has already been reconciled would otherwise bind the store
      // back to the phrase it names, erasing the grants, revealed accounts,
      // and active-account selection of the phrase actually in use.
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
      await ensureEntropyBinding();

      const gate = gateNextRequest(isSubtreeKeyFetch);
      const late = ensureEntropyBinding();
      late.catch(() => undefined);
      await waitUntil(gate.hit);

      // While it is held, the user switches and a fresh request reconciles
      // the store to the phrase now in use.
      swapEntropy();
      const fresh = await ensureEntropyBinding();
      expect(fresh.state.origins).toStrictEqual({});

      gate.release();
      await expect(late).rejects.toThrow('secret recovery phrase changed');

      // The reconciled store is still the new phrase's.
      expect(stored).toMatchObject({
        origins: {},
        accounts: [0],
        resetNotice: 'phrase-changed',
      });
      expect((await ensureEntropyBinding()).fingerprint).toBe(
        fresh.fingerprint,
      );
    });
  });

  describe('a phrase switch away and back during one key batch', () => {
    it('resolves every address from the source the request named', async () => {
      /*
       * The mixing this rules out. A batch fetches one key per revealed
       * account concurrently. If the wallet's primary phrase changed to
       * another and back while those were in flight, one of them could be
       * answered from the other phrase, and a comparison of the primary
       * phrase before and after the batch would see the same phrase both
       * times: both checks pass, and the other wallet's address is cached and
       * returned as this wallet's.
       *
       * The harness arms exactly that: the next account key served *without*
       * a named source is answered from phrase B, while the primary phrase
       * ends where it started. Naming the source is what makes the response
       * attributable, so the batch below must come back entirely phrase A's.
       */
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
      const binding = await ensureEntropyBinding();

      answerNextUnsourcedKeyFrom(SOURCE_B);
      expect(await getOwnedAccounts(binding)).toStrictEqual([
        { index: 0, address: ADDRESS_0 },
        { index: 1, address: ADDRESS_1 },
      ]);
      // Nothing of phrase B reached the memo either, so a later read cannot
      // serve one.
      expect(await getAddressForIndex(binding, 1)).toBe(ADDRESS_1);
    });

    it('refuses the batch when the switch has not been undone', async () => {
      stored = stateV2({ origins: CONNECTED, accounts: [0, 1] });
      const binding = await ensureEntropyBinding();

      const gate = gateNextRequest(isAccountKeyFetch);
      const accounts = getOwnedAccounts(binding);
      accounts.catch(() => undefined);
      await waitUntil(gate.hit);
      // Still on phrase B when the batch finishes: the keys are A's, but the
      // wallet the user is holding is no longer the one that was granted.
      swapEntropy();
      gate.release();

      await expect(accounts).rejects.toThrow('secret recovery phrase changed');
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
      expect(await assertConnected(ORIGIN)).toMatchObject({
        fingerprint: expect.any(String),
      });
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

    it('records no grant for an origin that cannot be a state key', async () => {
      // `connectOrigin` refuses a name that would touch the prototype chain,
      // and the handler must not report success when nothing was recorded:
      // the origin would otherwise believe it is connected while every later
      // grant read says it is not. MetaMask supplies real URL origins, so
      // this is the defence-in-depth arm of that write, exercised here
      // because nothing else reaches it.
      expect(
        await requestAccess('__proto__').catch((error: Error) => error),
      ).toMatchObject({
        message: expect.stringContaining('could not be recorded'),
      });
      expect(
        (stored as { origins: Record<string, unknown> }).origins,
      ).toStrictEqual({});
      await expect(assertConnected('__proto__')).rejects.toThrow(
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
      expect(
        await getOwnedAccounts(await ensureEntropyBinding()),
      ).toStrictEqual([
        { index: 0, address: ADDRESS_0 },
        { index: 1, address: ADDRESS_1 },
      ]);
    });

    it('never yields an entry without an address', async () => {
      // Guards the invariant the removed non-null cast used to assume: an
      // address that failed to resolve must not surface as `undefined` in a
      // dapp-facing result.
      stored = stateV2({ accounts: [0, 1] });
      const owned = await getOwnedAccounts(await ensureEntropyBinding());
      for (const entry of owned) {
        expect(typeof entry.address).toBe('string');
        expect(entry.address).toMatch(/^G[A-Z2-7]{55}$/u);
      }
    });
  });
});
