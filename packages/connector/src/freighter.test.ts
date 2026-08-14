import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { createFreighterApi, WatchWalletChanges } from './freighter';
import { StellarSnapKitModule } from './kit-module';
import { StellarSnap } from './snap';
import type { Eip1193Provider } from './types';

const SNAP_ID = 'npm:stellar-soroban-snap';
const ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const NETWORK = {
  network: 'TESTNET',
  networkPassphrase: 'Test SDF Network ; September 2015',
};
const NETWORK_DETAILS = {
  ...NETWORK,
  networkUrl: 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
};

/**
 * Builds a mock provider answering snap invocations from a method table.
 *
 * @param handlers - Map of snap method name to result or thrown error.
 * @returns The mock provider.
 */
function mockProvider(handlers: Record<string, unknown> = {}): Eip1193Provider {
  return {
    request: jest.fn(async (args: { method: string; params?: unknown }) => {
      if (
        args.method === 'wallet_getSnaps' ||
        args.method === 'wallet_requestSnaps'
      ) {
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
}

describe('createFreighterApi', () => {
  it('answers the read methods with Freighter-shaped results', async () => {
    const provider = mockProvider({
      getAddress: { address: ADDRESS },
      getNetwork: NETWORK,
      getNetworkDetails: NETWORK_DETAILS,
    });
    const api = createFreighterApi({ provider });

    expect(await api.isConnected()).toStrictEqual({ isConnected: true });
    expect(await api.getNetwork()).toStrictEqual(NETWORK);
    expect(await api.getNetworkDetails()).toStrictEqual(NETWORK_DETAILS);
    expect(await api.isAllowed()).toStrictEqual({ isAllowed: true });
  });

  it('reports not allowed when no access has been granted', async () => {
    const provider = mockProvider({ getAddress: { address: '' } });
    const api = createFreighterApi({ provider });
    expect(await api.isAllowed()).toStrictEqual({ isAllowed: false });
  });

  it('setAllowed and requestAccess connect through the snap', async () => {
    const provider = mockProvider({
      requestAccess: { address: ADDRESS },
    });
    const api = createFreighterApi({ provider });

    expect(await api.setAllowed()).toStrictEqual({ isAllowed: true });
    expect(await api.requestAccess()).toStrictEqual({ address: ADDRESS });
  });

  it('signAuthEntry and signMessage pass through', async () => {
    const provider = mockProvider({
      signAuthEntry: { signedAuthEntry: 'AAAA', signerAddress: ADDRESS },
      signMessage: { signedMessage: 'BBBB', signerAddress: ADDRESS },
    });
    const api = createFreighterApi({ provider });

    expect(await api.signAuthEntry('AAAA')).toStrictEqual({
      signedAuthEntry: 'AAAA',
      signerAddress: ADDRESS,
    });
    expect(await api.signMessage('hello')).toStrictEqual({
      signedMessage: 'BBBB',
      signerAddress: ADDRESS,
    });
  });

  it('folds non-StellarSnapError failures into a generic error', async () => {
    // toStellarSnapError normalizes provider throws, so exercise the
    // fallback by making the snap client itself fail past normalization:
    // a malformed response shape produces a StellarSnapError, while a
    // non-error throw from a patched method hits the generic arm.
    const provider = mockProvider({});
    const api = createFreighterApi({ provider });
    jest.spyOn(api.snap, 'getNetwork').mockRejectedValue('not an error object');

    const result = await api.getNetwork();
    expect(result.error).toStrictEqual({ code: -1, message: 'Unknown error.' });
  });
});

describe('WatchWalletChanges', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits on the first poll and only when the key changes', async () => {
    jest.useFakeTimers();
    const provider = mockProvider({
      getAddress: { address: ADDRESS },
      getNetwork: NETWORK,
    });
    const snap = new StellarSnap({ provider });
    const watcher = new WatchWalletChanges(snap, 1000);
    const updates: unknown[] = [];

    watcher.watch((update) => updates.push(update));
    await jest.advanceTimersByTimeAsync(1000);
    expect(updates).toStrictEqual([
      {
        address: ADDRESS,
        network: NETWORK.network,
        networkPassphrase: NETWORK.networkPassphrase,
      },
    ]);

    // Unchanged wallet state: no further callbacks.
    await jest.advanceTimersByTimeAsync(3000);
    expect(updates).toHaveLength(1);

    watcher.stop();
    await jest.advanceTimersByTimeAsync(3000);
    expect(updates).toHaveLength(1);
  });

  it('swallows poll errors and keeps polling', async () => {
    jest.useFakeTimers();
    const provider = mockProvider({});
    const snap = new StellarSnap({ provider });
    const watcher = new WatchWalletChanges(snap, 1000);
    const updates: unknown[] = [];

    watcher.watch((update) => updates.push(update));
    await jest.advanceTimersByTimeAsync(2500);
    expect(updates).toHaveLength(0);
    watcher.stop();
  });
});

describe('StellarSnapKitModule signing passthrough', () => {
  it('maps the kit signing and network methods to the snap client', async () => {
    const provider = mockProvider({
      signTransaction: { signedTxXdr: 'AAAA', signerAddress: ADDRESS },
      signAuthEntry: { signedAuthEntry: 'BBBB', signerAddress: ADDRESS },
      signMessage: { signedMessage: 'CCCC', signerAddress: ADDRESS },
      getNetwork: NETWORK,
    });
    const module = new StellarSnapKitModule({ provider });

    expect(await module.signTransaction('AAAA')).toStrictEqual({
      signedTxXdr: 'AAAA',
      signerAddress: ADDRESS,
    });
    expect(await module.signAuthEntry('BBBB')).toStrictEqual({
      signedAuthEntry: 'BBBB',
      signerAddress: ADDRESS,
    });
    expect(await module.signMessage('hi')).toStrictEqual({
      signedMessage: 'CCCC',
      signerAddress: ADDRESS,
    });
    expect(await module.getNetwork()).toStrictEqual(NETWORK);
  });
});
