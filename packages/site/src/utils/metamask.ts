import type {
  EIP6963AnnounceProviderEvent,
  MetaMaskInpageProvider,
} from '@metamask/providers';

/**
 * MetaMask EIP-6963 rdns values, matched EXACTLY. Substring matching on
 * `io.metamask` would admit look-alike wallets that embed the string in
 * their own rdns; mirror the connector's exact allowlist.
 */
const METAMASK_RDNS = new Set([
  'io.metamask',
  'io.metamask.flask',
  'io.metamask.mmi',
]);

/**
 * Check if the current provider supports snaps by calling `wallet_getSnaps`.
 *
 * @param provider - The provider to use to check for snaps support. Defaults to
 * `window.ethereum`.
 * @returns True if the provider supports snaps, false otherwise.
 */
export async function hasSnapsSupport(
  provider: MetaMaskInpageProvider = window.ethereum,
) {
  try {
    await provider.request({
      method: 'wallet_getSnaps',
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Get a MetaMask provider using EIP6963. This will return the first provider
 * reporting as MetaMask. If no provider is found after 500ms, this will
 * return null instead.
 *
 * @returns A MetaMask provider if found, otherwise null.
 */
export async function getMetaMaskEIP6963Provider() {
  return new Promise<MetaMaskInpageProvider | null>((resolve) => {
    // Timeout looking for providers after 500ms
    const timeout = setTimeout(() => {
      resolveWithCleanup(null);
    }, 500);

    /**
     * Resolve the promise with a MetaMask provider and clean up.
     *
     * @param provider - A MetaMask provider if found, otherwise null.
     */
    function resolveWithCleanup(provider: MetaMaskInpageProvider | null) {
      window.removeEventListener(
        'eip6963:announceProvider',
        onAnnounceProvider,
      );

      clearTimeout(timeout);
      resolve(provider);
    }

    /**
     * Listener for the EIP6963 announceProvider event.
     *
     * Resolves the promise if a MetaMask provider is found.
     *
     * @param event - The EIP6963 announceProvider event.
     * @param event.detail - The details of the EIP6963 announceProvider event.
     */
    function onAnnounceProvider({ detail }: EIP6963AnnounceProviderEvent) {
      if (!detail) {
        return;
      }

      const { info, provider } = detail;

      if (METAMASK_RDNS.has(info.rdns)) {
        resolveWithCleanup(provider);
      }
    }

    window.addEventListener('eip6963:announceProvider', onAnnounceProvider);

    window.dispatchEvent(new Event('eip6963:requestProvider'));
  });
}

/**
 * Get a provider that supports snaps. EIP-6963 discovery (exact MetaMask
 * rdns match) is tried first; the legacy `window.ethereum` fallbacks are
 * only accepted when the provider reports `isMetaMask` and passes the
 * snaps-support probe.
 *
 * @returns The provider, or `null` if no provider supports snaps.
 */
export async function getSnapsProvider() {
  if (typeof window === 'undefined') {
    return null;
  }

  // Prefer EIP-6963 discovery first: announcements are matched against the
  // exact MetaMask rdns allowlist above, so a look-alike wallet squatting on
  // `window.ethereum` cannot be selected ahead of the real MetaMask.
  const eip6963Provider = await getMetaMaskEIP6963Provider();

  if (eip6963Provider && (await hasSnapsSupport(eip6963Provider))) {
    return eip6963Provider;
  }

  // Legacy fallbacks: only accept a provider that both claims to be MetaMask
  // and answers the snaps probe.
  if (window.ethereum?.isMetaMask && (await hasSnapsSupport())) {
    return window.ethereum;
  }

  if (window.ethereum?.detected) {
    for (const provider of window.ethereum.detected) {
      if (provider?.isMetaMask && (await hasSnapsSupport(provider))) {
        return provider;
      }
    }
  }

  if (window.ethereum?.providers) {
    for (const provider of window.ethereum.providers) {
      if (provider?.isMetaMask && (await hasSnapsSupport(provider))) {
        return provider;
      }
    }
  }

  return null;
}
