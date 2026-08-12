import type { StellarSnapOptions } from './snap';
import { StellarSnap } from './snap';
import type {
  NetworkDetailsResult,
  NetworkResult,
  SignAuthEntryOptions,
  SignMessageOptions,
  SignTransactionOptions,
} from './types';
import { StellarSnapError } from './types';

/** Freighter-style error shape. */
export type FreighterApiError = { code: number; message: string };

type WithError<Type> = Partial<Type> & { error?: FreighterApiError };

/**
 * Runs a call and folds failures into Freighter's `{ ...result, error }`
 * convention instead of throwing. Post-approval recovery data preserved on
 * the typed error (the signed envelope, signer, hash, status of a
 * submit-after-sign failure) is spread alongside `error`, so facade
 * consumers can still poll or retry a transaction the user already signed.
 *
 * @param work - The underlying call.
 * @returns The result, or `{ ...recoveryData, error }`.
 */
async function soft<Type extends Record<string, unknown>>(
  work: () => Promise<Type>,
): Promise<WithError<Type>> {
  try {
    return await work();
  } catch (error) {
    // The cast is safe by convention: on failure, the only result-shaped
    // fields present are the validated recovery strings from `error.data`.
    if (error instanceof StellarSnapError) {
      return {
        ...(error.data ?? {}),
        error: { code: error.code, message: error.message },
      } as WithError<Type>;
    }
    return {
      error: { code: -1, message: 'Unknown error.' },
    } as WithError<Type>;
  }
}

/**
 * Polls for wallet address/network changes, mirroring Freighter's
 * `WatchWalletChanges` helper.
 */
export class WatchWalletChanges {
  readonly #snap: StellarSnap;

  readonly #intervalMs: number;

  #timer: ReturnType<typeof setInterval> | undefined;

  #last = '';

  constructor(snap: StellarSnap, intervalMs = 3000) {
    this.#snap = snap;
    this.#intervalMs = intervalMs;
  }

  /**
   * Starts polling.
   *
   * @param callback - Invoked whenever the address, network, or passphrase
   * changes.
   */
  watch(
    callback: (update: {
      address: string;
      network: string;
      networkPassphrase: string;
    }) => void,
  ): void {
    this.stop();
    this.#timer = setInterval(() => {
      Promise.all([this.#snap.getAddress(), this.#snap.getNetwork()])
        .then(([{ address }, network]) => {
          const key = `${address}|${network.network}|${network.networkPassphrase}`;
          if (key !== this.#last) {
            this.#last = key;
            callback({
              address,
              network: network.network,
              networkPassphrase: network.networkPassphrase,
            });
          }
          return null;
        })
        .catch(() => null);
    }, this.#intervalMs);
  }

  /** Stops polling. */
  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}

/**
 * Builds a drop-in replacement for `@stellar/freighter-api` backed by the
 * snap: same method names, same `{ ...result, error? }` return convention.
 *
 * @param options - Snap client options (snap ID, version, provider).
 * @returns The Freighter-shaped API object.
 */
export function createFreighterApi(options: StellarSnapOptions = {}) {
  const snap = new StellarSnap(options);

  return {
    /** The underlying typed client, for direct use. */
    snap,

    async isConnected(): Promise<{ isConnected: boolean }> {
      return { isConnected: await snap.isAvailable() };
    },

    async isAllowed(): Promise<{ isAllowed: boolean }> {
      try {
        const { address } = await snap.getAddress();
        return { isAllowed: address !== '' };
      } catch {
        return { isAllowed: false };
      }
    },

    async setAllowed(): Promise<WithError<{ isAllowed: boolean }>> {
      return soft(async () => {
        await snap.connect();
        return { isAllowed: true };
      });
    },

    async requestAccess(): Promise<WithError<{ address: string }>> {
      return soft(async () => snap.connect());
    },

    async getAddress(): Promise<WithError<{ address: string }>> {
      return soft(async () => snap.getAddress());
    },

    async getNetwork(): Promise<WithError<NetworkResult>> {
      return soft(async () => snap.getNetwork());
    },

    async getNetworkDetails(): Promise<WithError<NetworkDetailsResult>> {
      return soft(async () => snap.getNetworkDetails());
    },

    async signTransaction(
      xdr: string,
      opts?: SignTransactionOptions,
    ): Promise<WithError<{ signedTxXdr: string; signerAddress: string }>> {
      return soft(async () => snap.signTransaction(xdr, opts));
    },

    async signAuthEntry(
      authEntry: string,
      opts?: SignAuthEntryOptions,
    ): Promise<WithError<{ signedAuthEntry: string; signerAddress: string }>> {
      return soft(async () => snap.signAuthEntry(authEntry, opts));
    },

    async signMessage(
      message: string,
      opts?: SignMessageOptions,
    ): Promise<WithError<{ signedMessage: string; signerAddress: string }>> {
      return soft(async () => snap.signMessage(message, opts));
    },
  };
}
