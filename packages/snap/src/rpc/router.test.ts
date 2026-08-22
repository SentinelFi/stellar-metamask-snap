import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { JsonRpcRequest } from '@metamask/snaps-sdk';
import { MethodNotFoundError, SnapError } from '@metamask/snaps-sdk';

import { externalServiceError, userRejected } from './errors';
import { MAX_INFLIGHT_PER_ORIGIN, resetRequestLimits } from './limiter';
import { route } from './router';
import { assertDialogAllowed, recordDialogRejection } from './throttle';
import { getAddress } from '../handlers/access';
import { getNetwork } from '../handlers/network';
import { signTransaction } from '../handlers/sign';

// The router's job is dispatch, error laundering, and throttle bookkeeping —
// not handler behavior, which has its own suites. Handlers are mocked so
// each routing property can be exercised directly; the throttle is mocked
// (with its real DIALOG_METHODS set) so rejection bookkeeping is observable
// without replaying three real rejections per test. (ts-jest hoists these
// mock calls above the imports.)
jest.mock('../handlers/access', () => ({
  requestAccess: jest.fn(),
  getAddress: jest.fn(),
}));
jest.mock('../handlers/account', () => ({
  addToken: jest.fn(),
  getBalances: jest.fn(),
  fund: jest.fn(),
}));
jest.mock('../handlers/accounts', () => ({
  getAccounts: jest.fn(),
  setActiveAccount: jest.fn(),
}));
jest.mock('../handlers/network', () => ({
  getNetwork: jest.fn(),
  getNetworkDetails: jest.fn(),
  setNetwork: jest.fn(),
}));
jest.mock('../handlers/sign', () => ({
  signAuthEntry: jest.fn(),
  signMessage: jest.fn(),
  signTransaction: jest.fn(),
}));
jest.mock('./throttle', () => ({
  ...jest.requireActual<Record<string, unknown>>('./throttle'),
  assertDialogAllowed: jest.fn(),
  recordDialogRejection: jest.fn(),
}));

const ORIGIN = 'https://dapp.example';

/**
 * Builds a JSON-RPC request for the router.
 *
 * @param method - The method name.
 * @param params - Optional params.
 * @returns The request.
 */
function request(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id: 1, method, params } as JsonRpcRequest;
}

describe('route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRequestLimits();
  });

  it('dispatches to the handler with origin and params', async () => {
    (signTransaction as jest.Mock).mockImplementation(async () => ({
      signedTxXdr: 'AAAA',
    }));

    const result = await route(
      ORIGIN,
      request('signTransaction', { xdr: 'AAAA' }),
    );
    expect(result).toStrictEqual({ signedTxXdr: 'AAAA' });
    expect(signTransaction).toHaveBeenCalledWith(ORIGIN, { xdr: 'AAAA' });
  });

  it('throws method-not-found for unknown methods', async () => {
    await expect(route(ORIGIN, request('nonsense'))).rejects.toThrow(
      MethodNotFoundError,
    );
  });

  it('refuses inherited object properties as method names', async () => {
    // `toString`/`constructor` resolve on any plain object; dispatching on
    // them would call something that was never a handler.
    await expect(route(ORIGIN, request('toString'))).rejects.toThrow(
      MethodNotFoundError,
    );
    await expect(route(ORIGIN, request('constructor'))).rejects.toThrow(
      MethodNotFoundError,
    );
  });

  it('passes SnapErrors through unchanged', async () => {
    (getNetwork as jest.Mock).mockImplementation(async () => {
      throw externalServiceError('Horizon is down.');
    });

    await expect(route(ORIGIN, request('getNetwork'))).rejects.toThrow(
      'Horizon is down.',
    );
  });

  it('replaces unexpected exceptions with a generic internal error', async () => {
    (getAddress as jest.Mock).mockImplementation(async () => {
      throw new TypeError('secret internal detail: /home/user/key.ts:42');
    });

    const error = await route(ORIGIN, request('getAddress')).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SnapError);
    expect((error as SnapError).message).toBe('Internal error.');
    expect((error as SnapError).message).not.toContain('secret');
  });

  it('gates dialog methods on the dialog throttle', async () => {
    (signTransaction as jest.Mock).mockImplementation(async () => ({}));
    await route(ORIGIN, request('signTransaction', {}));
    expect(assertDialogAllowed).toHaveBeenCalledWith(ORIGIN);

    (getAddress as jest.Mock).mockImplementation(async () => ({}));
    (assertDialogAllowed as jest.Mock).mockClear();
    await route(ORIGIN, request('getAddress'));
    expect(assertDialogAllowed).not.toHaveBeenCalled();
  });

  it('records user rejections of dialog methods, and only those', async () => {
    (signTransaction as jest.Mock).mockImplementation(async () => {
      throw userRejected();
    });
    await expect(route(ORIGIN, request('signTransaction', {}))).rejects.toThrow(
      'The user rejected this request.',
    );
    expect(recordDialogRejection).toHaveBeenCalledWith(ORIGIN);

    // A non-rejection failure of a dialog method is not dialog fatigue.
    (recordDialogRejection as jest.Mock).mockClear();
    (signTransaction as jest.Mock).mockImplementation(async () => {
      throw externalServiceError('boom');
    });
    await expect(route(ORIGIN, request('signTransaction', {}))).rejects.toThrow(
      'boom',
    );
    expect(recordDialogRejection).not.toHaveBeenCalled();
  });

  it('enforces the per-method rate limit', async () => {
    (signTransaction as jest.Mock).mockImplementation(async () => ({}));
    // The signTransaction window allows 20 requests per minute.
    for (let index = 0; index < 20; index += 1) {
      await route(ORIGIN, request('signTransaction', {}));
    }
    await expect(route(ORIGIN, request('signTransaction', {}))).rejects.toThrow(
      'Too many signTransaction requests',
    );
  });
});

describe('route: refusal shapes and concurrency wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRequestLimits();
  });

  it('bounds the echoed method name and carries the SEP-43 code', async () => {
    const name = `x${'y'.repeat(500)}`;
    const error = await route(ORIGIN, request(name)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MethodNotFoundError);
    expect((error as Error).message.length).toBeLessThan(100);
    expect((error as SnapError).data).toMatchObject({ code: -3 });
  });

  it('refuses a request beyond the per-origin in-flight budget', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (getNetwork as jest.Mock).mockImplementation(async () => {
      await gate;
      return {};
    });
    const pending = Array.from({ length: MAX_INFLIGHT_PER_ORIGIN }, async () =>
      route(ORIGIN, request('getNetwork')),
    );
    // Let the in-flight counter observe every pending request.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(route(ORIGIN, request('getNetwork'))).rejects.toThrow(
      'Too many concurrent requests from this site',
    );
    release();
    await Promise.all(pending);
    // Released slots are reusable.
    expect(await route(ORIGIN, request('getNetwork'))).toStrictEqual({});
  });
});
