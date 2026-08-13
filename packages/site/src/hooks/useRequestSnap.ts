import { useMetaMaskContext } from './MetamaskContext';
import { useRequest } from './useRequest';
import { defaultSnapOrigin, defaultSnapVersion } from '../config';
import type { Snap } from '../types';

/**
 * Utility hook to wrap the `wallet_requestSnaps` method.
 *
 * @param snapId - The requested Snap ID. Defaults to the snap ID specified in the
 * config.
 * @param version - The requested version. Defaults to the version specified in
 * the config (`GATSBY_SNAP_VERSION`), so production installs pin the audited release.
 * @returns The `wallet_requestSnaps` wrapper.
 */
export const useRequestSnap = (
  snapId = defaultSnapOrigin,
  version = defaultSnapVersion,
) => {
  const request = useRequest();
  const { setInstalledSnap } = useMetaMaskContext();

  /**
   * Request the Snap.
   */
  const requestSnap = async () => {
    const snaps = (await request({
      method: 'wallet_requestSnaps',
      params: {
        // Only npm-hosted snaps are versioned; a `local:` snap is whatever
        // the development server is currently serving.
        [snapId]: snapId.startsWith('npm:') && version ? { version } : {},
      },
    })) as Record<string, Snap>;

    // Updates the `installedSnap` context variable since we just installed the Snap.
    setInstalledSnap(snaps?.[snapId] ?? null);
  };

  return requestSnap;
};
