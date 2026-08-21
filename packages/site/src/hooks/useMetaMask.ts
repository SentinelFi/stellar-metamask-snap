import { useCallback, useEffect, useState } from 'react';

import { useMetaMaskContext } from './MetamaskContext';
import { useRequest } from './useRequest';
import { defaultSnapOrigin } from '../config';
import type { GetSnapsResponse } from '../types';

/**
 * A hook to retrieve useful data from MetaMask.
 *
 * @returns The information.
 */
export const useMetaMask = () => {
  const { provider, setInstalledSnap, installedSnap } = useMetaMaskContext();
  const request = useRequest();

  const [isFlask, setIsFlask] = useState(false);

  const snapsDetected = provider !== null;

  /**
   * Detect if the version of MetaMask is Flask.
   */
  const detectFlask = useCallback(async () => {
    const clientVersion = await request({
      method: 'web3_clientVersion',
    });

    // `web3_clientVersion` returns a single user-agent style string such as
    // "MetaMask/v13.5.0-flask.0", so this is deliberately a substring check
    // on that string. (Null, from a failed request, simply means no Flask.)
    const isFlaskDetected =
      typeof clientVersion === 'string' && clientVersion.includes('flask');

    setIsFlask(isFlaskDetected);
  }, [request]);

  /**
   * Get the Snap informations from MetaMask.
   */
  const getSnap = useCallback(async () => {
    // `useRequest` resolves to null on error, so the result must be indexed
    // defensively rather than assumed to be a snaps map.
    const snaps = (await request({
      method: 'wallet_getSnaps',
    })) as GetSnapsResponse | null;

    setInstalledSnap(snaps?.[defaultSnapOrigin] ?? null);
  }, [request, setInstalledSnap]);

  useEffect(() => {
    const detect = async () => {
      if (provider) {
        await detectFlask();
        await getSnap();
      }
    };

    // Detection failures leave the "install Flask" state in place.
    detect().catch(() => undefined);
  }, [provider, detectFlask, getSnap]);

  // Re-read the installed snap whenever the tab regains focus or becomes
  // visible again. The snapshot above is taken once per provider, and
  // MetaMask can update the snap under the same npm ID while this page stays
  // open; updating it means leaving the tab, so focus is the moment the
  // snapshot can have gone stale. The connector additionally re-verifies the
  // pinned version before every signing call, so this keeps the *displayed*
  // readiness honest rather than being the only guard.
  useEffect(() => {
    if (!provider) {
      return undefined;
    }
    const refresh = () => {
      getSnap().catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [provider, getSnap]);

  return { isFlask, snapsDetected, installedSnap, getSnap };
};
