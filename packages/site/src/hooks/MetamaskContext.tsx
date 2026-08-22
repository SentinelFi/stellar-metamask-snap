import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import type { Eip1193Provider } from 'stellar-soroban-snap-connector';

import type { Snap } from '../types';
import { getSnapsProvider } from '../utils';

type MetaMaskContextType = {
  provider: Eip1193Provider | null;
  installedSnap: Snap | null;
  error: Error | null;
  setInstalledSnap: (snap: Snap | null) => void;
  /** Passing null clears the error box; the page offers a dismiss control. */
  setError: (error: Error | null) => void;
};

export const MetaMaskContext = createContext<MetaMaskContextType>({
  provider: null,
  installedSnap: null,
  error: null,
  setInstalledSnap: () => {
    /* no-op */
  },
  setError: () => {
    /* no-op */
  },
});

/**
 * MetaMask context provider to handle MetaMask and snap status.
 *
 * @param props - React Props.
 * @param props.children - React component to be wrapped by the Provider.
 * @returns JSX.
 */
export const MetaMaskProvider = ({ children }: { children: ReactNode }) => {
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [installedSnap, setInstalledSnap] = useState<Snap | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // A failed provider probe leaves `provider` null (no MetaMask detected).
    getSnapsProvider()
      .then(setProvider)
      .catch(() => undefined);
  }, []);

  // Discovery gives announcements a short window, and a cold-start MetaMask
  // can announce after it closes. Rather than leave the page on "install
  // MetaMask" until a reload, probe again whenever the tab regains focus or
  // becomes visible while no provider has been found, the same moments the
  // installed-snap snapshot is refreshed.
  useEffect(() => {
    if (provider) {
      return undefined;
    }
    const reprobe = () => {
      getSnapsProvider()
        .then((found) => {
          if (found) {
            setProvider(found);
          }
          return undefined;
        })
        .catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        reprobe();
      }
    };
    window.addEventListener('focus', reprobe);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', reprobe);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [provider]);

  useEffect(() => {
    if (error) {
      const timeout = setTimeout(() => {
        setError(null);
      }, 10000);

      return () => {
        clearTimeout(timeout);
      };
    }

    return undefined;
  }, [error]);

  return (
    <MetaMaskContext.Provider
      value={{ provider, error, setError, installedSnap, setInstalledSnap }}
    >
      {children}
    </MetaMaskContext.Provider>
  );
};

/**
 * Utility hook to consume the MetaMask context.
 *
 * @returns The MetaMask context.
 */
export function useMetaMaskContext() {
  return useContext(MetaMaskContext);
}
