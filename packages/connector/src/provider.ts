import type { Eip1193Provider } from './types';

/**
 * MetaMask EIP-6963 rdns values. Matched EXACTLY — `includes()`-style
 * matching would let look-alike wallets spoof detection.
 */
const METAMASK_RDNS = new Set([
  'io.metamask',
  'io.metamask.flask',
  'io.metamask.mmi',
]);

type Eip6963AnnounceEvent = CustomEvent<{
  info: { rdns: string };
  provider: Eip1193Provider;
}>;

/**
 * Discovers a MetaMask provider via EIP-6963, falling back to
 * `window.ethereum`. Returns null when MetaMask is not present.
 *
 * @param timeoutMs - How long to wait for EIP-6963 announcements.
 * @returns The provider, or null.
 */
export async function getMetaMaskProvider(
  timeoutMs = 300,
): Promise<Eip1193Provider | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  const found = await new Promise<Eip1193Provider | null>((resolve) => {
    const providers: Eip1193Provider[] = [];

    const onAnnounce = (event: Event) => {
      const { detail } = event as Eip6963AnnounceEvent;
      if (detail?.info?.rdns && METAMASK_RDNS.has(detail.info.rdns)) {
        providers.push(detail.provider);
      }
    };

    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      resolve(providers[0] ?? null);
    }, timeoutMs);
  });

  if (found) {
    return found;
  }

  // Legacy fallback: window.ethereum when it looks like MetaMask.
  const legacy = (
    window as unknown as {
      ethereum?: Eip1193Provider & { isMetaMask?: boolean };
    }
  ).ethereum;
  if (legacy?.isMetaMask) {
    return legacy;
  }
  return null;
}

/**
 * Whether the provider supports MetaMask Snaps (stable with allowlisted
 * snaps, or Flask). Detected by probing `wallet_getSnaps`.
 *
 * @param provider - The provider to probe.
 * @returns True when snaps are supported.
 */
export async function supportsSnaps(
  provider: Eip1193Provider,
): Promise<boolean> {
  try {
    await provider.request({ method: 'wallet_getSnaps' });
    return true;
  } catch {
    return false;
  }
}
