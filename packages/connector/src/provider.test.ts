import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { getMetaMaskProvider, supportsSnaps } from './provider';
import type { Eip1193Provider } from './types';

/**
 * A window stand-in for the node test environment: a real EventTarget (so
 * the EIP-6963 listener/dispatch flow runs unmocked) plus the `ethereum`
 * slot the legacy fallback reads.
 */
type FakeWindow = EventTarget & { ethereum?: unknown };

/**
 * Installs a fake `window` for one test.
 *
 * @returns The fake window.
 */
function installWindow(): FakeWindow {
  const fake: FakeWindow = new EventTarget();
  (globalThis as { window?: unknown }).window = fake;
  return fake;
}

/**
 * Builds a minimal valid provider object.
 *
 * @returns The provider.
 */
function validProvider(): Eip1193Provider {
  return { request: jest.fn(async () => null) as Eip1193Provider['request'] };
}

/**
 * Registers an EIP-6963 announcer on the fake window: when discovery
 * dispatches `eip6963:requestProvider`, the announcer answers with the given
 * detail, mirroring how real wallets participate in the handshake.
 *
 * @param fake - The fake window.
 * @param detail - The announcement detail.
 */
function announceOnRequest(fake: FakeWindow, detail: unknown): void {
  fake.addEventListener('eip6963:requestProvider', () => {
    // Not a CustomEvent (unavailable on the supported Node range): the
    // production code reads only `.detail`, which a plain Event can carry.
    const event = new Event('eip6963:announceProvider') as Event & {
      detail: unknown;
    };
    event.detail = detail;
    fake.dispatchEvent(event);
  });
}

describe('getMetaMaskProvider', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('returns null outside a browser environment', async () => {
    expect(await getMetaMaskProvider(10)).toBeNull();
  });

  it('resolves a valid EIP-6963 announcement with a MetaMask rdns', async () => {
    const fake = installWindow();
    const provider = validProvider();
    announceOnRequest(fake, { info: { rdns: 'io.metamask' }, provider });

    expect(await getMetaMaskProvider()).toBe(provider);
  });

  it('ignores announcements from other wallets', async () => {
    const fake = installWindow();
    announceOnRequest(fake, {
      info: { rdns: 'com.example.wallet' },
      provider: validProvider(),
    });

    expect(await getMetaMaskProvider(10)).toBeNull();
  });

  it('requires exact rdns matches, not substrings', async () => {
    // `includes()`-style matching would accept look-alike values such as
    // "io.metamask.evil"; the set membership check must not.
    const fake = installWindow();
    announceOnRequest(fake, {
      info: { rdns: 'io.metamask.evil' },
      provider: validProvider(),
    });

    expect(await getMetaMaskProvider(10)).toBeNull();
  });

  it('rejects announcements whose provider is not request-callable', async () => {
    // An announcement is page-controlled data: a claimed MetaMask rdns with
    // a garbage provider object must be dropped at discovery time.
    const fake = installWindow();
    announceOnRequest(fake, {
      info: { rdns: 'io.metamask' },
      provider: { request: 'not a function' },
    });

    expect(await getMetaMaskProvider(10)).toBeNull();
  });

  it('takes the first valid announcement when several arrive', async () => {
    const fake = installWindow();
    const first = validProvider();
    const second = validProvider();
    announceOnRequest(fake, { info: { rdns: 'io.metamask' }, provider: first });
    announceOnRequest(fake, {
      info: { rdns: 'io.metamask.flask' },
      provider: second,
    });

    expect(await getMetaMaskProvider()).toBe(first);
  });

  it('falls back to a request-callable window.ethereum with isMetaMask', async () => {
    const fake = installWindow();
    const legacy = { ...validProvider(), isMetaMask: true };
    fake.ethereum = legacy;

    expect(await getMetaMaskProvider(10)).toBe(legacy);
  });

  it('rejects a legacy provider that lacks a callable request', async () => {
    const fake = installWindow();
    fake.ethereum = { isMetaMask: true };

    expect(await getMetaMaskProvider(10)).toBeNull();
  });

  it('rejects a legacy provider that does not identify as MetaMask', async () => {
    const fake = installWindow();
    fake.ethereum = validProvider();

    expect(await getMetaMaskProvider(10)).toBeNull();
  });
});

describe('supportsSnaps', () => {
  it('reports true when wallet_getSnaps succeeds', async () => {
    const provider: Eip1193Provider = {
      request: jest.fn(async () => ({})) as Eip1193Provider['request'],
    };
    expect(await supportsSnaps(provider)).toBe(true);
  });

  it('reports false when wallet_getSnaps throws', async () => {
    const provider: Eip1193Provider = {
      request: jest.fn(async () => {
        throw new Error('unsupported');
      }) as Eip1193Provider['request'],
    };
    expect(await supportsSnaps(provider)).toBe(false);
  });
});
