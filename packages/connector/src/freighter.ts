import type { StellarSnapOptions } from './snap.js';
import { StellarSnap } from './snap.js';
import type {
  NetworkDetailsResult,
  NetworkResult,
  SignAuthEntryOptions,
  SignMessageOptions,
  SignTransactionOptions,
  StellarSnapErrorData,
} from './types.js';
import { StellarSnapError } from './types.js';

/**
 * Freighter-style error shape, extended with an explicit recovery bag.
 *
 * `recovery` carries the post-approval data of a submit-after-sign failure
 * (the signed envelope, signer, hash, status), so a caller can still poll or
 * retry a transaction the user already signed. It lives on the error, not on
 * the result: real `@stellar/freighter-api` returns empty result fields on
 * failure, and the very common pattern of destructuring `signedTxXdr` and
 * submitting when it is truthy must not silently submit an envelope from a
 * call the dapp believes failed. Reaching into `error.recovery` is an opt-in.
 */
export type FreighterApiError = {
  code: number;
  message: string;
  /** Post-approval recovery data, when the failure produced any. */
  recovery?: StellarSnapErrorData;
};

type WithError<Type> = Partial<Type> & { error?: FreighterApiError };

/**
 * Runs a call and folds failures into Freighter's `{ ...result, error }`
 * convention instead of throwing. On failure the result fields stay empty
 * (matching `@stellar/freighter-api`); any recovery data preserved on the
 * typed error is exposed as `error.recovery`.
 *
 * @param work - The underlying call.
 * @returns The result, or `{ error }`.
 */
async function soft<Type extends Record<string, unknown>>(
  work: () => Promise<Type>,
): Promise<WithError<Type>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StellarSnapError) {
      return {
        error: {
          code: error.code,
          message: error.message,
          ...(error.data ? { recovery: error.data } : {}),
        },
      } as WithError<Type>;
    }
    return {
      error: { code: -1, message: 'Unknown error.' },
    } as WithError<Type>;
  }
}

/** The update a {@link WatchWalletChanges} listener receives. */
export type WalletChange = {
  address: string;
  network: string;
  networkPassphrase: string;
};

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
  watch(callback: (update: WalletChange) => void): void {
    this.stop();
    this.#timer = setInterval(() => {
      // A failed poll (MetaMask locked, snap mid-update, page offline) is
      // not an event the listener can act on; the next tick retries.
      this.#poll(callback).catch(() => undefined);
    }, this.#intervalMs);
  }

  /**
   * One poll: reads the address and network, and notifies the listener
   * when the combination differs from the last one it was told about.
   *
   * @param callback - The listener registered with `watch`.
   */
  async #poll(callback: (update: WalletChange) => void): Promise<void> {
    const [{ address }, network] = await Promise.all([
      this.#snap.getAddress(),
      this.#snap.getNetwork(),
    ]);
    const key = `${address}|${network.network}|${network.networkPassphrase}`;
    if (key === this.#last) {
      return;
    }
    this.#last = key;
    callback({
      address,
      network: network.network,
      networkPassphrase: network.networkPassphrase,
    });
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
