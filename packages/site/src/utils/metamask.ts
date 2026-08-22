import type { Eip1193Provider } from 'stellar-soroban-snap-connector';
import {
  getMetaMaskProvider,
  supportsSnaps,
} from 'stellar-soroban-snap-connector';

/**
 * Finds the MetaMask provider this page will drive, or null when none is
 * present.
 *
 * Discovery is the connector's, not a copy of it. The page used to carry its
 * own EIP-6963 listener and a set of `window.ethereum` fallbacks, and the
 * copy was weaker than the original in three ways: it resolved the first
 * MetaMask-rdns announcement without checking that the announced object had
 * a `request` function, it dereferenced `info.rdns` without guarding an
 * empty `detail`, and it accepted entries from `window.ethereum.detected`
 * and `.providers` (the arrays other wallets inject into) on the strength of
 * a truthy `isMetaMask`. The provider chosen here is what the connector is
 * then constructed with, so the connector's stricter discovery never ran for
 * this page. One implementation means one set of rules, and the connector's
 * are the reviewed ones: exact rdns matching, a structural check on the
 * announced provider, and a snaps-support probe.
 *
 * @returns The provider, or null when MetaMask is absent or predates snaps.
 */
export async function getSnapsProvider(): Promise<Eip1193Provider | null> {
  if (typeof window === 'undefined') {
    return null;
  }
  const provider = await getMetaMaskProvider();
  if (provider === null || !(await supportsSnaps(provider))) {
    return null;
  }
  return provider;
}
