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

  return { isFlask, snapsDetected, installedSnap, getSnap };
};
