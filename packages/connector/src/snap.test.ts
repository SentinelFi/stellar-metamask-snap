import { describe, expect, it, jest } from '@jest/globals';

import { createFreighterApi } from './freighter';
import { StellarSnapKitModule } from './kit-module';
import { StellarSnap } from './snap';
import type { Eip1193Provider } from './types';
import { StellarSnapError } from './types';

const SNAP_ID = 'npm:stellar-soroban-snap';
const ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

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
    expect(requests[0]).toStrictEqual({
      method: 'wallet_invokeSnap',
      params: { snapId: SNAP_ID, request: { method: 'getAddress' } },
    });
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
    expect(requests[0]).toStrictEqual({
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
    });
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
        balances: [{ asset: 'XLM', balance: '10.0000000' }],
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
