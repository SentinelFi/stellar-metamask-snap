import type { Eip1193Provider } from './types.js';

/**
 * MetaMask EIP-6963 rdns values. Matched EXACTLY — `includes()`-style
 * matching would let look-alike wallets spoof detection.
 *
 * Know the limit of this check: EIP-6963 announcements are plain DOM events,
 * so any script already running in the page can announce whatever rdns it
 * likes. Exact matching screens out honestly-named third-party wallets, not
 * a compromised page. A page-level attacker who pre-announces as MetaMask
 * captures the provider slot; MetaMask's own confirmation dialogs remain the
 * trust boundary for everything that matters (a captured provider cannot
 * produce signatures, only observe requests and lie in responses, which is
 * why responses are validated at the call sites).
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
 * Whether a value structurally looks like an EIP-1193 provider. An
 * announcement carrying anything else is ignored at discovery time, where
 * the problem is attributable, instead of surfacing later as a confusing
 * TypeError inside the first request.
 *
 * @param value - The candidate provider object.
 * @returns True when the value has a callable `request`.
 */
function isEip1193Provider(value: unknown): value is Eip1193Provider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { request?: unknown }).request === 'function'
  );
}

/**
 * Discovers a MetaMask provider via EIP-6963, falling back to
 * `window.ethereum`. Returns null when MetaMask is not present.
 *
 * Resolves on the first valid announcement rather than waiting out the
 * whole window: MetaMask announces immediately on the request event, and
 * announcement order is not a trust signal (see {@link METAMASK_RDNS}), so
 * waiting longer only adds latency without adding certainty.
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
    // The abort controller detaches the announcement listener on settle;
    // the timeout timer is left to fire and settle into a no-op, which
    // spares the listener/timer cleanup from referencing each other.
    const controller = new AbortController();
    let settled = false;

    const finish = (value: Eip1193Provider | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      controller.abort();
      resolve(value);
    };

    window.addEventListener(
      'eip6963:announceProvider',
      (event: Event): void => {
        const { detail } = event as Eip6963AnnounceEvent;
        if (
          detail?.info?.rdns &&
          METAMASK_RDNS.has(detail.info.rdns) &&
          isEip1193Provider(detail.provider)
        ) {
          finish(detail.provider);
        }
      },
      { signal: controller.signal },
    );
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => finish(null), timeoutMs);
  });

  if (found) {
    return found;
  }

  // Legacy fallback: window.ethereum when it identifies as MetaMask and has
  // a callable request method. `isMetaMask` is a page-writable boolean, so
  // this adds compatibility with pre-6963 injections, not security; the
  // same caveat as announcement spoofing above applies.
  const legacy = (window as unknown as { ethereum?: unknown }).ethereum;
  if (
    isEip1193Provider(legacy) &&
    (legacy as { isMetaMask?: boolean }).isMetaMask
  ) {
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
