import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { createFreighterApi } from './freighter';
import { StellarSnapKitModule } from './kit-module';
import { StellarSnap } from './snap';
import type { Eip1193Provider } from './types';
import { StellarSnapError } from './types';

const SNAP_ID = 'npm:stellar-soroban-snap';
const LOCAL_SNAP_ID = 'local:http://localhost:8080';
const ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

type RecordedRequest = { method: string; params?: unknown };

/**
 * The subset of recorded provider requests with a given method, in order.
 * Tests that assert on the payload of an invocation use this rather than a
 * fixed index, because an `npm:` client reads `wallet_getSnaps` once before
 * its first invocation and the position of the invocation depends on it.
 *
 * @param requests - The recorded request list.
 * @param method - The provider method to keep.
 * @returns The matching requests.
 */
function ofMethod(
  requests: RecordedRequest[],
  method: string,
): RecordedRequest[] {
  return requests.filter((request) => request.method === method);
}

/**
 * Builds a provider that answers every `wallet_*` read with a snaps map
 * naming one installed version, so the pin and the reported install can be
 * made to agree or disagree from a single argument, and that answers
 * `wallet_invokeSnap` from a method table.
 *
 * @param installedVersion - The version reported under `snapId`, or null to
 * report the snap as not installed at all.
 * @param snapId - The snap ID the map names.
 * @param handlers - Map of snap method name to result.
 * @returns The mock provider and the recorded request list.
 */
function providerReporting(
  installedVersion: string | null,
  snapId = SNAP_ID,
  handlers: Record<string, unknown> = { getAddress: { address: ADDRESS } },
) {
  const requests: RecordedRequest[] = [];
  const snaps =
    installedVersion === null
      ? {}
      : { [snapId]: { version: installedVersion } };
  const provider: Eip1193Provider = {
    request: jest.fn(async (args: RecordedRequest) => {
      requests.push(args);
      if (args.method === 'wallet_invokeSnap') {
        const inner = (args.params as { request: { method: string } }).request;
        const handler = handlers[inner.method];
        if (handler === undefined) {
          throw new Error(`Unhandled snap method: ${inner.method}`);
        }
        return handler;
      }
      return snaps;
    }) as Eip1193Provider['request'],
  };
  return { provider, requests };
}

/**
 * Like {@link providerReporting}, but the reported version can be changed
 * between calls, to model a user updating the snap mid-session.
 *
 * @returns The mock provider, the recorded request list, and a setter for
 * the reported version.
 */
function providerWithMutableVersion() {
  const requests: RecordedRequest[] = [];
  let installed = '0.1.0';
  const provider: Eip1193Provider = {
    request: jest.fn(async (args: RecordedRequest) => {
      requests.push(args);
      if (args.method === 'wallet_invokeSnap') {
        return { address: ADDRESS };
      }
      return { [SNAP_ID]: { version: installed } };
    }) as Eip1193Provider['request'],
  };
  return {
    provider,
    requests,
    setInstalled: (version: string) => {
      installed = version;
    },
  };
}

/**
 * Like {@link providerWithMutableVersion}, but every `wallet_getSnaps` read
 * stays pending until the test releases it, and the response reports the
 * version installed at the moment the read *began*: a lookup that was in
 * flight when the user updated the snap answers with what it observed, not
 * with the state at resolution time.
 *
 * @returns The mock provider, the recorded request list, a setter for the
 * reported version, and the queue of pending `wallet_getSnaps` releases in
 * arrival order.
 */
function providerWithDeferredSnapReads() {
  const requests: RecordedRequest[] = [];
  let installed = '0.1.0';
  const releases: (() => void)[] = [];
  const provider: Eip1193Provider = {
    request: jest.fn(async (args: RecordedRequest) => {
      requests.push(args);
      if (args.method === 'wallet_getSnaps') {
        const snapshot = { [SNAP_ID]: { version: installed } };
        return new Promise((resolve) => {
          releases.push(() => resolve(snapshot));
        });
      }
      return { address: ADDRESS };
    }) as Eip1193Provider['request'],
  };
  return {
    provider,
    requests,
    releases,
    setInstalled: (version: string) => {
      installed = version;
    },
  };
}

/**
 * Yields event-loop turns until the probe reports true, so a test can hold a
 * call at a known pending point before driving the next step. Each iteration
 * yields a macrotask rather than a bare microtask, so awaited timers and I/O
 * keep running; a probe that never turns true is caught by the test timeout.
 * Declared at module scope because the loop is a conditional, which
 * `jest/no-conditional-in-test` refuses in a test body.
 *
 * @param probe - Returns true once the awaited condition holds.
 */
async function waitUntil(probe: () => boolean): Promise<void> {
  while (!probe()) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Builds a mock EIP-1193 provider that records requests and answers snap
 * invocations from a method → result/error table.
 *
 * @param handlers - Map of snap method name to result or thrown error.
 * @returns The mock provider and the recorded request list.
 */
function mockProvider(handlers: Record<string, unknown> = {}) {
  const requests: { method: string; params?: unknown }[] = [];

  const provider: Eip1193Provider = {
    request: jest.fn(async (args: { method: string; params?: unknown }) => {
      requests.push(args);
      if (args.method === 'wallet_getSnaps') {
        return { [SNAP_ID]: { version: '0.1.0' } };
      }
      if (args.method === 'wallet_requestSnaps') {
        return { [SNAP_ID]: { version: '0.1.0' } };
      }
      if (args.method === 'wallet_invokeSnap') {
        const inner = (args.params as { request: { method: string } }).request;
        const handler = handlers[inner.method];
        if (handler instanceof Error) {
          throw handler;
        }
        if (handler === undefined) {
          throw new Error(`Unhandled snap method: ${inner.method}`);
        }
        return handler;
      }
      throw new Error(`Unhandled provider method: ${args.method}`);
    }) as Eip1193Provider['request'],
  };

  return { provider, requests };
}

/**
 * Builds an error shaped like MetaMask's serialized snap errors.
 *
 * @param message - The error message.
 * @param code - The SEP-43 code placed in `data.code`.
 * @returns The error object.
 */
function snapError(message: string, code: number): Error {
  const error = new Error(message) as Error & { data: { code: number } };
  error.data = { code };
  return error;
}

describe('StellarSnap', () => {
  it('invokes snap methods with the correct payload shape', async () => {
    const { provider, requests } = mockProvider({
      getAddress: { address: ADDRESS },
    });
    const snap = new StellarSnap({ provider });

    expect(await snap.getAddress()).toStrictEqual({ address: ADDRESS });
    expect(ofMethod(requests, 'wallet_invokeSnap')).toStrictEqual([
      {
        method: 'wallet_invokeSnap',
        params: { snapId: SNAP_ID, request: { method: 'getAddress' } },
      },
    ]);
  });

  it('passes SEP-43 option bags through signTransaction', async () => {
    const { provider, requests } = mockProvider({
      signTransaction: { signedTxXdr: 'xdr', signerAddress: ADDRESS },
    });
    const snap = new StellarSnap({ provider });

    await snap.signTransaction('AAAA', {
      networkPassphrase: 'Test SDF Network ; September 2015',
      submit: true,
    });
    expect(ofMethod(requests, 'wallet_invokeSnap')).toStrictEqual([
      {
        method: 'wallet_invokeSnap',
        params: {
          snapId: SNAP_ID,
          request: {
            method: 'signTransaction',
            params: {
              xdr: 'AAAA',
              networkPassphrase: 'Test SDF Network ; September 2015',
              submit: true,
            },
          },
        },
      },
    ]);
  });

  it('passes networkPassphrase through signMessage', async () => {
    // SEP-43 defines the option for signMessage too; a conformant caller
    // must be able to pass it and have the wallet compare it.
    const { provider, requests } = mockProvider({
      signMessage: { signedMessage: 'sig', signerAddress: ADDRESS },
    });
    const snap = new StellarSnap({ provider });

    await snap.signMessage('hello', {
      networkPassphrase: 'Test SDF Network ; September 2015',
      address: ADDRESS,
    });
    expect(ofMethod(requests, 'wallet_invokeSnap')).toStrictEqual([
      {
        method: 'wallet_invokeSnap',
        params: {
          snapId: SNAP_ID,
          request: {
            method: 'signMessage',
            params: {
              networkPassphrase: 'Test SDF Network ; September 2015',
              address: ADDRESS,
              message: 'hello',
            },
          },
        },
      },
    ]);
  });

  it('refuses submitUrl client-side without contacting the wallet', async () => {
    // The snap submits only to its own allowlisted endpoints. A caller
    // naming another one must get a clear refusal, not a generic invalid
    // request from the snap, and never a silent drop that leaves it
    // believing its endpoint was used.
    const { provider, requests } = mockProvider({
      signTransaction: { signedTxXdr: 'xdr', signerAddress: ADDRESS },
    });
    const snap = new StellarSnap({ provider });

    await expect(
      snap.signTransaction('AAAA', {
        submit: true,
        submitUrl: 'https://horizon.example',
      }),
    ).rejects.toMatchObject({
      code: -3,
      message: expect.stringContaining('submitUrl'),
    });
    expect(requests).toHaveLength(0);
  });

  it('lets the positional payload win over a same-named option key', async () => {
    // Option bags are forwarded from other layers; one carrying `xdr`,
    // `authEntry`, or `message` must not replace what the caller passed by
    // position. The option types do not declare those keys, so the test
    // smuggles them in the way a loosely typed caller would.
    const { provider, requests } = mockProvider({
      signTransaction: { signedTxXdr: 'xdr', signerAddress: ADDRESS },
      signAuthEntry: { signedAuthEntry: 'AAAA', signerAddress: ADDRESS },
      signMessage: { signedMessage: 'sig', signerAddress: ADDRESS },
    });
    const snap = new StellarSnap({ provider });

    await snap.signTransaction('REAL', { xdr: 'FAKE' } as never);
    await snap.signAuthEntry('REAL', { authEntry: 'FAKE' } as never);
    await snap.signMessage('REAL', { message: 'FAKE' } as never);
    const sent = ofMethod(requests, 'wallet_invokeSnap').map(
      (request) =>
        (request.params as { request: { params: Record<string, unknown> } })
          .request.params,
    );
    expect(sent).toStrictEqual([
      { xdr: 'REAL' },
      { authEntry: 'REAL' },
      { message: 'REAL' },
    ]);
  });

  it('normalizes snap errors into StellarSnapError with SEP-43 codes', async () => {
    const { provider } = mockProvider({
      signMessage: snapError('The user rejected this request.', -4),
    });
    const snap = new StellarSnap({ provider });

    await expect(snap.signMessage('hi')).rejects.toThrow(StellarSnapError);
    await expect(snap.signMessage('hi')).rejects.toMatchObject({
      code: -4,
      message: 'The user rejected this request.',
    });
  });

  it('preserves post-submission recovery data in the error', async () => {
    // The snap attaches the signed envelope to a submit-failure error so the
    // caller can poll or retry; the connector must not discard it.
    const error = new Error('Transaction submission failed.') as Error & {
      data: Record<string, unknown>;
    };
    error.data = {
      code: -2,
      signedTxXdr: 'AAAAsigned',
      signerAddress: ADDRESS,
      status: 'ERROR',
    };
    const { provider } = mockProvider({ signTransaction: error });
    const snap = new StellarSnap({ provider });

    await expect(
      snap.signTransaction('AAAA', { submit: true }),
    ).rejects.toMatchObject({
      code: -2,
      data: {
        signedTxXdr: 'AAAAsigned',
        signerAddress: ADDRESS,
        status: 'ERROR',
      },
    });
  });

  it('leaves error data undefined when the snap sent none', async () => {
    const { provider } = mockProvider({
      signMessage: snapError('bad', -3),
    });
    const snap = new StellarSnap({ provider });
    const caught = await snap
      .signMessage('hi')
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(StellarSnapError);
    expect((caught as StellarSnapError).data).toBeUndefined();
  });

  it('connect requests the snap with the pinned version for npm IDs', async () => {
    const { provider, requests } = mockProvider({
      requestAccess: { address: ADDRESS },
    });
    const snap = new StellarSnap({ provider });

    expect(await snap.connect()).toStrictEqual({ address: ADDRESS });
    expect(requests[0]).toStrictEqual({
      method: 'wallet_requestSnaps',
      params: { [SNAP_ID]: { version: '0.1.0' } },
    });
    // requestAccess is a dialog-confirmed call, so it drops the memo the
    // wallet_requestSnaps verification just set and re-reads wallet_getSnaps:
    // MetaMask can update the snap under the same ID mid-session, and every
    // sensitive call is compared against the pin at the moment it is made.
    expect(requests.map((request) => request.method)).toStrictEqual([
      'wallet_requestSnaps',
      'wallet_getSnaps',
      'wallet_invokeSnap',
    ]);
  });

  it('isInstalled checks wallet_getSnaps for the snap ID', async () => {
    const { provider } = mockProvider();
    const snap = new StellarSnap({ provider });
    expect(await snap.isInstalled()).toBe(true);
  });

  it('rejects semver ranges and malformed snap IDs at construction', () => {
    // A range would silently defeat the audited-release pin; an arbitrary
    // snap ID would request something this connector was never meant to
    // install. Both come from dapp config/env in practice.
    expect(() => new StellarSnap({ version: '^0.1.0' })).toThrow(TypeError);
    expect(() => new StellarSnap({ version: '*' })).toThrow(TypeError);
    expect(() => new StellarSnap({ snapId: 'https://evil.example' })).toThrow(
      TypeError,
    );
    expect(
      () => new StellarSnap({ snapId: 'local:http://localhost:8080' }),
    ).not.toThrow();
  });

  it('connect fails when MetaMask reports a different installed version', async () => {
    // Answers every wallet_* call with a snaps map naming an older version,
    // so the requested pin and the reported install disagree.
    const provider: Eip1193Provider = {
      request: jest.fn(async () => ({
        [SNAP_ID]: { version: '0.0.9' },
      })) as Eip1193Provider['request'],
    };
    const snap = new StellarSnap({ provider });

    await expect(snap.connect()).rejects.toMatchObject({
      code: -3,
      message: expect.stringContaining('0.0.9'),
    });
  });

  it('isInstalled reports false for a wrong-version npm snap', async () => {
    const provider: Eip1193Provider = {
      request: jest.fn(async () => ({
        [SNAP_ID]: { version: '0.0.9' },
      })) as Eip1193Provider['request'],
    };
    const snap = new StellarSnap({ provider });
    expect(await snap.isInstalled()).toBe(false);
  });

  it('rejects responses that do not match the documented shape', async () => {
    // The provider is discovered from the page environment; a typed method
    // must not hand a malformed value to dapp code as a validated result.
    const { provider } = mockProvider({
      getAddress: { address: 42 },
      getBalances: { address: ADDRESS, funded: 'yes', balances: [] },
    });
    const snap = new StellarSnap({ provider });

    await expect(snap.getAddress()).rejects.toMatchObject({ code: -1 });
    await expect(snap.getBalances()).rejects.toMatchObject({ code: -1 });
  });

  it('validates and returns the account, funding, and token methods', async () => {
    const account = { index: 1, address: ADDRESS };
    const { provider } = mockProvider({
      getAccounts: { accounts: [account], activeIndex: 1 },
      setActiveAccount: account,
      fund: { funded: true, address: ADDRESS },
      getBalances: {
        address: ADDRESS,
        funded: true,
        sequence: '1',
        balances: [{ asset: 'XLM', balance: '10.0000000', type: 'native' }],
      },
      addToken: { contractId: 'CABC', symbol: 'USDC', decimals: 7 },
      signAuthEntry: { signedAuthEntry: 'AAAA', signerAddress: ADDRESS },
    });
    const snap = new StellarSnap({ provider });

    expect(await snap.getAccounts()).toStrictEqual({
      accounts: [account],
      activeIndex: 1,
    });
    expect(await snap.setActiveAccount(1)).toStrictEqual(account);
    expect(await snap.fund(ADDRESS)).toStrictEqual({
      funded: true,
      address: ADDRESS,
    });
    expect((await snap.getBalances()).funded).toBe(true);
    expect((await snap.addToken('CABC', 'Test SDF')).symbol).toBe('USDC');
    expect((await snap.signAuthEntry('AAAA')).signedAuthEntry).toBe('AAAA');
  });

  it('treats a present local snap as installed without a version check', async () => {
    const localId = 'local:http://localhost:8080';
    const provider: Eip1193Provider = {
      request: jest.fn(async () => ({
        [localId]: { version: '0.1.0-local' },
      })) as Eip1193Provider['request'],
    };
    const snap = new StellarSnap({ provider, snapId: localId });
    expect(await snap.isInstalled()).toBe(true);
  });

  it('fails with externalService when MetaMask is absent', async () => {
    // No provider supplied and no window: discovery yields null.
    const snap = new StellarSnap();
    await expect(snap.getAddress()).rejects.toMatchObject({ code: -2 });
    expect(await snap.isAvailable()).toBe(false);
    expect(await snap.isInstalled()).toBe(false);
  });

  it('maps unknown error codes to internal instead of passing them through', async () => {
    // Dapps branch on the four SEP-43 codes; an arbitrary upstream number
    // must not be able to impersonate one.
    const { provider } = mockProvider({
      signMessage: snapError('spoofed', -4000),
    });
    const snap = new StellarSnap({ provider });

    await expect(snap.signMessage('hi')).rejects.toMatchObject({ code: -1 });
  });
});

describe('StellarSnap version check on invocation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses a typed call when a different version is installed', async () => {
    // The pin was previously verified only by connect(); a dapp that reads
    // getAddress() first (the common "connect only if empty" pattern) would
    // otherwise run against whatever release is installed under the ID.
    const { provider, requests } = providerReporting('0.0.9');
    const snap = new StellarSnap({ provider });

    await expect(snap.getAddress()).rejects.toMatchObject({
      code: -3,
      message: expect.stringContaining('0.0.9'),
    });
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(0);
  });

  it('refuses the raw invoke path on a mismatch too', async () => {
    const { provider, requests } = providerReporting('0.0.9');
    const snap = new StellarSnap({ provider });

    await expect(snap.invoke('getAddress')).rejects.toMatchObject({
      code: -3,
    });
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(0);
  });

  it('reads wallet_getSnaps once for the public network reads', async () => {
    // The memo exists for the calls that disclose nothing about the wallet:
    // the network reads are answerable to any origin, so a verified pin may
    // be remembered for them.
    const { provider, requests } = providerReporting('0.1.0', SNAP_ID, {
      getNetwork: { network: 'TESTNET' },
    });
    const snap = new StellarSnap({ provider });

    await snap.invoke('getNetwork');
    await snap.invoke('getNetwork');
    await snap.invoke('getNetwork');
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(1);
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(3);
  });

  it('compares the privacy reads against the pin on every call', async () => {
    // getAddress, getAccounts, and getBalances are silent but not public:
    // they disclose addresses, the linked account inventory, and balances.
    // A replacement snap under the same npm ID holds the same granted
    // permissions, so a memo written before an update cannot vouch for a
    // read that would run the replacement's code over that data.
    const { provider, requests, setInstalled } = providerWithMutableVersion();
    const snap = new StellarSnap({ provider });

    expect(await snap.getAddress()).toStrictEqual({ address: ADDRESS });

    setInstalled('0.2.0');
    await expect(snap.getAddress()).rejects.toMatchObject({
      code: -3,
      message: expect.stringContaining('0.2.0'),
    });
    await expect(snap.getAccounts()).rejects.toMatchObject({ code: -3 });
    await expect(snap.getBalances()).rejects.toMatchObject({ code: -3 });
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(4);
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(1);
  });

  it('keeps answering the public network reads from the memo', async () => {
    // The narrower guarantee, stated as a test so it cannot widen silently:
    // only the network reads trust a pin verified earlier in the session.
    const { provider, requests, setInstalled } = providerWithMutableVersion();
    const snap = new StellarSnap({ provider });

    expect(await snap.getAddress()).toStrictEqual({ address: ADDRESS });
    setInstalled('0.2.0');
    await snap.invoke('getNetwork');
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(1);
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(2);
  });

  it('shares one wallet_getSnaps read between concurrent first calls', async () => {
    // A page typically fires several reads together on load; they must not
    // each pay for (and race) their own verification.
    const { provider, requests } = providerReporting('0.1.0', SNAP_ID, {
      getNetwork: { network: 'TESTNET' },
    });
    const snap = new StellarSnap({ provider });

    await Promise.all([
      snap.invoke('getNetwork'),
      snap.invoke('getNetwork'),
      snap.invoke('getNetwork'),
    ]);
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(1);
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(3);
  });

  it('re-checks after a mismatch rather than remembering it', async () => {
    // The user may update the snap between calls; a refused call must not
    // poison the client for the rest of the session.
    const { provider, requests, setInstalled } = providerWithMutableVersion();
    const snap = new StellarSnap({ provider });

    setInstalled('0.0.9');
    await expect(snap.getAddress()).rejects.toMatchObject({ code: -3 });
    setInstalled('0.1.0');
    expect(await snap.getAddress()).toStrictEqual({ address: ADDRESS });
    // The successful re-check is remembered for the public reads.
    await snap.invoke('getNetwork');
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(2);
  });

  it('fails a signing call closed after a mid-session snap update', async () => {
    // The memo is trusted only by the public reads. MetaMask can update the
    // snap under the same npm ID while the page stays open; the next signing
    // or dialog-confirmed call must re-read wallet_getSnaps and refuse, not
    // run against a release the page never compared to the pin.
    const { provider, requests, setInstalled } = providerWithMutableVersion();
    const snap = new StellarSnap({ provider });

    expect(await snap.getAddress()).toStrictEqual({ address: ADDRESS });

    setInstalled('0.2.0');
    // The public read still answers from the memo...
    await snap.invoke('getNetwork');
    // ...and the sensitive call is what re-compares and fails closed.
    await expect(snap.signMessage('hello')).rejects.toMatchObject({
      code: -3,
      message: expect.stringContaining('0.2.0'),
    });
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(2);
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(2);
  });

  it('fails a raw signing invocation closed after a mid-session update', async () => {
    // invoke() accepts arbitrary method names, so the memo is trusted only
    // for the read-only allowlist. A raw signMessage would otherwise bypass
    // the fresh comparison the typed wrapper performs, running whatever
    // release now sits under the npm ID.
    const { provider, requests, setInstalled } = providerWithMutableVersion();
    const snap = new StellarSnap({ provider });

    expect(await snap.getAddress()).toStrictEqual({ address: ADDRESS });

    setInstalled('0.2.0');
    await expect(
      snap.invoke('signMessage', { message: 'hello' }),
    ).rejects.toMatchObject({
      code: -3,
      message: expect.stringContaining('0.2.0'),
    });
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(2);
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(1);
  });

  it('fails the dialog-free fund call closed after a mid-session update', async () => {
    // fund is side-effecting but shows no snap dialog, so nothing downstream
    // would surface a release change to the user; it must take the same
    // fresh comparison as the signing methods, not ride the silent-read
    // memo.
    const { provider, requests, setInstalled } = providerWithMutableVersion();
    const snap = new StellarSnap({ provider });

    expect(await snap.getAddress()).toStrictEqual({ address: ADDRESS });

    setInstalled('0.2.0');
    await expect(snap.fund()).rejects.toMatchObject({
      code: -3,
      message: expect.stringContaining('0.2.0'),
    });
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(2);
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(1);
  });

  it('does not satisfy a sensitive call with a lookup begun before it', async () => {
    // A public read can leave a wallet_getSnaps lookup in flight when a
    // sensitive call arrives. That lookup observed the installed version
    // before the sensitive call was made, so a snap updated in between
    // would pass a check that predates it. The sensitive call must await a
    // lookup begun after itself.
    const { provider, requests, releases, setInstalled } =
      providerWithDeferredSnapReads();
    const snap = new StellarSnap({ provider });

    const read = snap.invoke('getNetwork');
    await waitUntil(() => releases.length === 1);

    // The snap updates while the read's lookup is still pending; the
    // sensitive call must start its own lookup rather than share it.
    setInstalled('0.2.0');
    const sensitive = snap.signMessage('hello');
    await waitUntil(() => releases.length === 2);

    // The stale lookup settles first, reporting the version it observed
    // before the update. Only the read that started it may trust that
    // answer.
    releases[0]?.();
    releases[1]?.();

    expect(await read).toStrictEqual({ address: ADDRESS });
    await expect(sensitive).rejects.toMatchObject({
      code: -3,
      message: expect.stringContaining('0.2.0'),
    });
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(2);
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(1);
  });

  it('refuses an earlier sensitive call whose check a later one outdated', async () => {
    // Two sensitive calls overlap. The second opens a newer generation while
    // the first's lookup is still in flight, and the newer lookup is the one
    // that sees the update. The first call's own lookup then settles with
    // the version it observed before the update: a success for its
    // generation, but one a later demand has already outdated. It must not
    // invoke on it; it repeats the check for the current generation and
    // fails closed like the call that noticed.
    const { provider, requests, releases, setInstalled } =
      providerWithDeferredSnapReads();
    const snap = new StellarSnap({ provider });

    const first = snap.signMessage('first');
    await waitUntil(() => releases.length === 1);

    setInstalled('0.2.0');
    const second = snap.signMessage('second');
    await waitUntil(() => releases.length === 2);

    // Opposite order: the newer lookup settles first and refuses...
    releases[1]?.();
    await expect(second).rejects.toMatchObject({
      code: -3,
      message: expect.stringContaining('0.2.0'),
    });

    // ...then the older one settles with its stale success. The first call
    // starts a third, current-generation lookup instead of invoking.
    releases[0]?.();
    await waitUntil(() => releases.length === 3);
    releases[2]?.();

    await expect(first).rejects.toMatchObject({
      code: -3,
      message: expect.stringContaining('0.2.0'),
    });
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(3);
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(0);
  });

  it('skips the check for local development snaps', async () => {
    const { provider, requests } = providerReporting(
      '0.1.0-local',
      LOCAL_SNAP_ID,
    );
    const snap = new StellarSnap({ provider, snapId: LOCAL_SNAP_ID });

    expect(await snap.getAddress()).toStrictEqual({ address: ADDRESS });
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(0);
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(1);
  });

  it('lets MetaMask answer when the snap is not installed at all', async () => {
    // Absence is not a version mismatch: MetaMask refuses the invocation
    // itself, exactly as it did before the check existed, so a dapp's
    // pre-install handling is unchanged.
    const { provider, requests } = providerReporting(null);
    const snap = new StellarSnap({ provider });

    expect(await snap.getAddress()).toStrictEqual({ address: ADDRESS });
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(1);
    expect(ofMethod(requests, 'wallet_invokeSnap')).toHaveLength(1);
  });

  it('treats a verified isInstalled() as the check for the public reads', async () => {
    const { provider, requests } = providerReporting('0.1.0', SNAP_ID, {
      getNetwork: { network: 'TESTNET' },
    });
    const snap = new StellarSnap({ provider });

    expect(await snap.isInstalled()).toBe(true);
    await snap.invoke('getNetwork');
    expect(ofMethod(requests, 'wallet_getSnaps')).toHaveLength(1);
  });

  it('covers the Freighter facade and the Wallets Kit module', async () => {
    // Both reach the typed methods without connect(): isAllowed() and
    // getAddress({ skipRequestAccess: true }) are the documented silent
    // paths, and both must refuse a mismatched install.
    const facade = createFreighterApi({
      provider: providerReporting('0.0.9').provider,
    });
    expect(await facade.isAllowed()).toStrictEqual({ isAllowed: false });
    expect((await facade.getAddress()).error?.code).toBe(-3);

    const module = new StellarSnapKitModule({
      provider: providerReporting('0.0.9').provider,
    });
    await expect(
      module.getAddress({ skipRequestAccess: true }),
    ).rejects.toMatchObject({ code: -3 });
  });

  it('warns when an npm snap ID other than the published one is used', () => {
    // Any npm: ID passes the shape check (a fork under test is legitimate)
    // but the guarantees documented for this connector describe the
    // published snap, so a substituted ID must be visible in the console.
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const { provider } = providerReporting('0.1.0');

    expect(() => new StellarSnap({ provider })).not.toThrow();
    expect(
      () => new StellarSnap({ provider, snapId: LOCAL_SNAP_ID }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();

    expect(
      () =>
        new StellarSnap({ provider, snapId: 'npm:stellar-soroban-snap-fork' }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('npm:stellar-soroban-snap-fork');
  });
});

describe('createFreighterApi', () => {
  it('folds errors into the { error } convention instead of throwing', async () => {
    const { provider } = mockProvider({
      signTransaction: snapError('The user rejected this request.', -4),
      getAddress: { address: ADDRESS },
    });
    const freighter = createFreighterApi({ provider });

    const result = await freighter.signTransaction('AAAA');
    expect(result.error).toStrictEqual({
      code: -4,
      message: 'The user rejected this request.',
    });

    expect(await freighter.getAddress()).toStrictEqual({ address: ADDRESS });
    expect(await freighter.isAllowed()).toStrictEqual({ isAllowed: true });
  });

  it('keeps recovery data off the result shape, under error.recovery', async () => {
    // A submit-after-sign failure carries the signed envelope; the facade
    // surfaces it under `error.recovery` so callers can poll or retry — but
    // never on the success-shaped fields, where the common
    // `if (signedTxXdr) submit(...)` pattern would submit an envelope from a
    // call the dapp believes failed.
    const error = new Error('Transaction submission failed.') as Error & {
      data: Record<string, unknown>;
    };
    error.data = {
      code: -2,
      signedTxXdr: 'AAAAsigned',
      signerAddress: ADDRESS,
      status: 'ERROR',
    };
    const { provider } = mockProvider({ signTransaction: error });
    const freighter = createFreighterApi({ provider });

    const result = await freighter.signTransaction('AAAA', { submit: true });
    expect(result.error?.code).toBe(-2);
    expect(result.signedTxXdr).toBeUndefined();
    expect(result.signerAddress).toBeUndefined();
    expect(result.error?.recovery).toStrictEqual({
      signedTxXdr: 'AAAAsigned',
      signerAddress: ADDRESS,
      status: 'ERROR',
    });
  });
});

describe('StellarSnapKitModule', () => {
  it('exposes kit metadata and maps getAddress through connect', async () => {
    const { provider, requests } = mockProvider({
      requestAccess: { address: ADDRESS },
      getAddress: { address: ADDRESS },
    });
    const module = new StellarSnapKitModule({ provider });

    expect(module.moduleType).toBe('HOT_WALLET');
    expect(module.productId).toBe('metamask-stellar-snap');
    expect(module.productIcon.startsWith('data:image/svg+xml')).toBe(true);

    expect(await module.getAddress()).toStrictEqual({ address: ADDRESS });
    expect(requests[0]?.method).toBe('wallet_requestSnaps');

    expect(await module.getAddress({ skipRequestAccess: true })).toStrictEqual({
      address: ADDRESS,
    });
  });

  it('reports availability from wallet_getSnaps support', async () => {
    const { provider } = mockProvider();
    const module = new StellarSnapKitModule({ provider });
    expect(await module.isAvailable()).toBe(true);
  });
});
