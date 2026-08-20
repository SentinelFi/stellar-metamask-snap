import type { FunctionComponent, ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AccountInfo,
  BalancesResult,
  NetworkDetailsResult,
} from 'stellar-soroban-snap-connector';
import { StellarSnap } from 'stellar-soroban-snap-connector';

import { useMetaMaskContext } from './MetamaskContext';
import { useMetaMask } from './useMetaMask';
import { defaultSnapOrigin, defaultSnapVersion } from '../config';
import { isExpectedSnapVersion } from '../utils';

export type WalletState = {
  /** The connector, or null until MetaMask exposes a provider. */
  client: StellarSnap | null;
  /** The snap is installed *and* is the release this site was built for. */
  ready: boolean;
  /** A snap is installed, but not the expected version. */
  versionMismatch: boolean;
  /** The active account's address; empty string until access is granted. */
  address: string;
  /** True once a grant exists, which is what unlocks the account panels. */
  connected: boolean;
  network: NetworkDetailsResult | null;
  accounts: AccountInfo[];
  activeIndex: number;
  balances: BalancesResult | null;
  /** A snap request is in flight; every control disables while it is. */
  busy: boolean;
  /** Re-reads address, network, accounts, and balances. */
  refresh: () => Promise<void>;
  /** Runs one connector call, serialized, with errors routed to the page. */
  run: <Type>(
    work: (client: StellarSnap) => Promise<Type>,
  ) => Promise<Type | null>;
};

const EMPTY: WalletState = {
  client: null,
  ready: false,
  versionMismatch: false,
  address: '',
  connected: false,
  network: null,
  accounts: [],
  activeIndex: 0,
  balances: null,
  busy: false,
  refresh: async () => undefined,
  run: async () => null,
};

const WalletContext = createContext<WalletState>(EMPTY);

/**
 * Shares one connector instance, one in-flight lock, and one snapshot of
 * wallet state across every panel on the page.
 *
 * The single lock is not just tidiness: MetaMask shows one snap dialog at a
 * time, so two panels each opening one would queue the second behind the
 * first while both rendered as ready. One `busy` flag, held from before the
 * request until after the refresh, keeps the page honest about that.
 *
 * @param props - Provider props.
 * @param props.children - The tree that reads wallet state.
 * @returns The provider.
 */
export const WalletProvider: FunctionComponent<{ children: ReactNode }> = ({
  children,
}) => {
  const { provider, setError } = useMetaMaskContext();
  const { installedSnap } = useMetaMask();

  const [address, setAddress] = useState('');
  const [network, setNetwork] = useState<NetworkDetailsResult | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [balances, setBalances] = useState<BalancesResult | null>(null);
  const [busy, setBusy] = useState(false);

  // The reentrancy guard for `run`. State updates are asynchronous, so two
  // rapid clicks could both read a stale `busy === false`; a ref flips
  // synchronously and closes that window. `busy` stays as state purely so
  // the controls re-render as disabled.
  const busyRef = useRef(false);

  // The constructor throws a TypeError for a snap ID outside `npm:`/`local:`
  // or a version that is not an exact `x.y.z`. It cannot do so for a value a
  // production build accepted: `gatsby-node.js` refuses any other origin than
  // the audited `npm:` ID and any version shape the connector would not take
  // (its `EXACT_VERSION` is the connector's `EXACT_SEMVER`), so a crash here
  // can only come from a development build with a hand-edited environment.
  const client = useMemo(
    () =>
      provider
        ? new StellarSnap({
            snapId: defaultSnapOrigin,
            ...(defaultSnapVersion ? { version: defaultSnapVersion } : {}),
            provider,
          })
        : null,
    [provider],
  );

  const versionMismatch =
    installedSnap !== null && !isExpectedSnapVersion(installedSnap);
  const ready = installedSnap !== null && !versionMismatch && client !== null;

  const refresh = useCallback(async () => {
    if (!ready || !client) {
      // A wrong-version snap is not read from at all, not even silently: the
      // page must never present it as the audited release.
      setAddress('');
      setNetwork(null);
      setAccounts([]);
      setBalances(null);
      return;
    }
    try {
      const [addressResult, details] = await Promise.all([
        client.getAddress(),
        client.getNetworkDetails(),
      ]);
      setNetwork(details);
      setAddress(addressResult.address);

      if (!addressResult.address) {
        // No grant yet. Everything below needs one, and asking anyway would
        // only produce errors the user cannot act on.
        setAccounts([]);
        setBalances(null);
        return;
      }

      // Grant-gated reads, settled independently: the token-balance path can
      // be refused by the wallet's own budget while the account list is
      // perfectly readable, and a shared catch would blank both.
      const [accountsResult, balancesResult] = await Promise.allSettled([
        client.getAccounts(),
        client.getBalances(),
      ]);
      if (accountsResult.status === 'fulfilled') {
        setAccounts(accountsResult.value.accounts);
        setActiveIndex(accountsResult.value.activeIndex);
      }
      setBalances(
        balancesResult.status === 'fulfilled' ? balancesResult.value : null,
      );
    } catch {
      // A failed status read is not worth an error box: it re-runs after the
      // next action, and the panels already show what they do not have.
      setNetwork(null);
    }
  }, [client, ready]);

  // Load the status strip as soon as the snap is ready, and re-load whenever
  // the installed snap changes (install, update, or a version that stops
  // matching). Read-only: nothing here opens a dialog.
  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const run = useCallback(
    async <Type,>(
      work: (snapClient: StellarSnap) => Promise<Type>,
    ): Promise<Type | null> => {
      if (busyRef.current || !client || !ready) {
        return null;
      }
      busyRef.current = true;
      setBusy(true);
      try {
        const value = await work(client);
        await refresh();
        return value;
      } catch (callError) {
        setError(
          callError instanceof Error ? callError : new Error(String(callError)),
        );
        return null;
      } finally {
        // The ref is a mutex, taken before the awaited work and released
        // after it; the atomic-updates rule cannot tell a deliberate release
        // from a write based on a stale pre-await read.
        // eslint-disable-next-line require-atomic-updates
        busyRef.current = false;
        setBusy(false);
      }
    },
    [client, ready, refresh, setError],
  );

  const value = useMemo<WalletState>(
    () => ({
      client,
      ready,
      versionMismatch,
      address,
      connected: address !== '',
      network,
      accounts,
      activeIndex,
      balances,
      busy,
      refresh,
      run,
    }),
    [
      client,
      ready,
      versionMismatch,
      address,
      network,
      accounts,
      activeIndex,
      balances,
      busy,
      refresh,
      run,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
};

/**
 * Reads the shared wallet state.
 *
 * @returns The wallet state.
 */
export const useWallet = (): WalletState => useContext(WalletContext);
