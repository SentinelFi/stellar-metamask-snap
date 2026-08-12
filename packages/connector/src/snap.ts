import { getMetaMaskProvider, supportsSnaps } from './provider';
import type {
  AddTokenResult,
  BalancesResult,
  Eip1193Provider,
  FundResult,
  GetAccountsResult,
  GetAddressResult,
  NetworkDetailsResult,
  NetworkName,
  NetworkResult,
  SetActiveAccountResult,
  SignAuthEntryOptions,
  SignAuthEntryResult,
  SignMessageOptions,
  SignMessageResult,
  SignTransactionOptions,
  SignTransactionResultWithWarnings,
  StellarSnapErrorData,
} from './types';
import { SEP43_ERROR_CODES, StellarSnapError } from './types';

/** The published snap ID. */
export const DEFAULT_SNAP_ID = 'npm:stellar-soroban-snap';

/**
 * The default version requested at install time. Pinned to the exact audited
 * release (no semver range) so installs cannot silently pick up a newer,
 * unaudited version.
 */
export const DEFAULT_SNAP_VERSION = '0.1.0';

export type StellarSnapOptions = {
  /** Snap ID; use `local:http://localhost:8080` during development. */
  snapId?: string;
  /**
   * Version passed to `wallet_requestSnaps` (npm snaps only). Defaults to
   * the exact audited release.
   */
  version?: string;
  /** EIP-1193 provider; auto-detected via EIP-6963 when omitted. */
  provider?: Eip1193Provider;
};

/**
 * Normalizes provider/snap errors into `StellarSnapError` with SEP-43 codes.
 *
 * @param error - The raw error.
 * @returns The normalized error, ready to throw.
 */
function toStellarSnapError(error: unknown): StellarSnapError {
  const raw = error as {
    message?: string;
    code?: number;
    data?: {
      code?: number;
      signedTxXdr?: unknown;
      signerAddress?: unknown;
      hash?: unknown;
      status?: unknown;
    };
  };
  const code =
    typeof raw?.data?.code === 'number'
      ? raw.data.code
      : SEP43_ERROR_CODES.internal;
  // MetaMask's own connect rejection (EIP-1193 4001) is a user rejection.
  const normalized = raw?.code === 4001 ? SEP43_ERROR_CODES.userRejected : code;
  // Preserve post-approval recovery data (signed envelope, hash, status) so a
  // caller can poll or retry after an ambiguous submission failure.
  const data: StellarSnapErrorData = {};
  for (const key of [
    'signedTxXdr',
    'signerAddress',
    'hash',
    'status',
  ] as const) {
    const value = raw?.data?.[key];
    if (typeof value === 'string') {
      data[key] = value;
    }
  }
  const hasData = Object.keys(data).length > 0;
  return new StellarSnapError(
    raw?.message ?? 'Unknown error.',
    normalized,
    hasData ? data : undefined,
  );
}

/**
 * Typed client for the Stellar Soroban MetaMask Snap. Methods mirror the
 * snap's SEP-0043 RPC surface and throw `StellarSnapError` on failure.
 */
export class StellarSnap {
  readonly snapId: string;

  readonly version: string;

  #provider: Eip1193Provider | null;

  constructor(options: StellarSnapOptions = {}) {
    this.snapId = options.snapId ?? DEFAULT_SNAP_ID;
    this.version = options.version ?? DEFAULT_SNAP_VERSION;
    this.#provider = options.provider ?? null;
  }

  /**
   * Resolves the provider, detecting MetaMask when not supplied.
   *
   * @returns The provider.
   */
  async getProvider(): Promise<Eip1193Provider> {
    if (!this.#provider) {
      this.#provider = await getMetaMaskProvider();
    }
    if (!this.#provider) {
      throw new StellarSnapError(
        'MetaMask was not detected.',
        SEP43_ERROR_CODES.externalService,
      );
    }
    return this.#provider;
  }

  /**
   * Whether MetaMask is present and supports snaps.
   *
   * @returns True when available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const provider = await this.getProvider();
      return await supportsSnaps(provider);
    } catch {
      return false;
    }
  }

  /**
   * Whether this snap is installed and connected to the dapp.
   *
   * @returns True when installed.
   */
  async isInstalled(): Promise<boolean> {
    try {
      const provider = await this.getProvider();
      const snaps = (await provider.request({
        method: 'wallet_getSnaps',
      })) as Record<string, unknown>;
      return Object.keys(snaps ?? {}).includes(this.snapId);
    } catch {
      return false;
    }
  }

  /**
   * Installs (or reconnects) the snap and requests wallet access.
   *
   * @returns The wallet address.
   */
  async connect(): Promise<GetAddressResult> {
    const provider = await this.getProvider();
    try {
      await provider.request({
        method: 'wallet_requestSnaps',
        params: {
          [this.snapId]: this.snapId.startsWith('npm:')
            ? { version: this.version }
            : {},
        },
      });
    } catch (error) {
      throw toStellarSnapError(error);
    }
    return this.requestAccess();
  }

  /**
   * Invokes a snap RPC method.
   *
   * @param method - The snap method name.
   * @param params - Optional params object.
   * @returns The method result.
   */
  async invoke<Type>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Type> {
    const provider = await this.getProvider();
    try {
      return (await provider.request({
        method: 'wallet_invokeSnap',
        params: {
          snapId: this.snapId,
          request: params ? { method, params } : { method },
        },
      })) as Type;
    } catch (error) {
      throw toStellarSnapError(error);
    }
  }

  /**
   * SEP-43 `requestAccess`: connect dialog on first use.
   *
   * @returns The wallet address.
   */
  async requestAccess(): Promise<GetAddressResult> {
    return this.invoke<GetAddressResult>('requestAccess');
  }

  /**
   * SEP-43 `getAddress`: silent; empty string when not granted.
   *
   * @returns The wallet address or `{ address: '' }`.
   */
  async getAddress(): Promise<GetAddressResult> {
    return this.invoke<GetAddressResult>('getAddress');
  }

  /**
   * SEP-43 `getNetwork`.
   *
   * @returns The active network and passphrase.
   */
  async getNetwork(): Promise<NetworkResult> {
    return this.invoke<NetworkResult>('getNetwork');
  }

  /**
   * Freighter-compatible `getNetworkDetails`.
   *
   * @returns Network, passphrase, Horizon URL, Soroban RPC URL.
   */
  async getNetworkDetails(): Promise<NetworkDetailsResult> {
    return this.invoke<NetworkDetailsResult>('getNetworkDetails');
  }

  /**
   * Switches the active network (dialog-confirmed).
   *
   * @param network - Target network name.
   * @returns The new network details.
   */
  async setNetwork(network: NetworkName): Promise<NetworkDetailsResult> {
    return this.invoke<NetworkDetailsResult>('setNetwork', { network });
  }

  /**
   * SEP-43 `signTransaction`.
   *
   * @param xdr - Base64 transaction envelope XDR.
   * @param options - Optional SEP-43 option bag.
   * @returns The signed envelope and signer address.
   */
  async signTransaction(
    xdr: string,
    options: SignTransactionOptions = {},
  ): Promise<SignTransactionResultWithWarnings> {
    return this.invoke<SignTransactionResultWithWarnings>('signTransaction', {
      xdr,
      ...options,
    });
  }

  /**
   * SEP-43 `signAuthEntry`.
   *
   * @param authEntry - Base64 SorobanAuthorizationEntry XDR.
   * @param options - Optional SEP-43 option bag.
   * @returns The signed entry and signer address.
   */
  async signAuthEntry(
    authEntry: string,
    options: SignAuthEntryOptions = {},
  ): Promise<SignAuthEntryResult> {
    return this.invoke<SignAuthEntryResult>('signAuthEntry', {
      authEntry,
      ...options,
    });
  }

  /**
   * SEP-43 `signMessage` (SEP-53).
   *
   * @param message - The message to sign.
   * @param options - Optional SEP-43 option bag.
   * @returns The base64 signature and signer address.
   */
  async signMessage(
    message: string,
    options: SignMessageOptions = {},
  ): Promise<SignMessageResult> {
    return this.invoke<SignMessageResult>('signMessage', {
      message,
      ...options,
    });
  }

  /**
   * Enumerates the accounts the user has revealed, with the active index
   * (requires a connected origin). Accounts are added from the snap home
   * page; the signing methods accept any revealed account via the SEP-43
   * `address` option.
   *
   * @returns The revealed accounts and the active index.
   */
  async getAccounts(): Promise<GetAccountsResult> {
    return this.invoke<GetAccountsResult>('getAccounts');
  }

  /**
   * Switches the wallet-global active account (dialog-confirmed; requires a
   * connected origin). Only accounts the user has revealed can be activated.
   *
   * @param index - The SEP-0005 account index to activate.
   * @returns The new active account.
   */
  async setActiveAccount(index: number): Promise<SetActiveAccountResult> {
    return this.invoke<SetActiveAccountResult>('setActiveAccount', { index });
  }

  /**
   * Friendbot funding (test networks; requires a connected origin).
   *
   * @param address - Optional address; defaults to the wallet account.
   * @returns The funded address.
   */
  async fund(address?: string): Promise<FundResult> {
    return this.invoke<FundResult>('fund', address ? { address } : {});
  }

  /**
   * Balances + sequence via Horizon, plus tracked Soroban token balances
   * (requires a connected origin).
   *
   * @param address - Optional address; defaults to the wallet account.
   * @returns The account summary.
   */
  async getBalances(address?: string): Promise<BalancesResult> {
    return this.invoke<BalancesResult>(
      'getBalances',
      address ? { address } : {},
    );
  }

  /**
   * Tracks a Soroban token (SAC/SEP-41) for balance display, after a
   * user confirmation (Freighter-parity `addToken`).
   *
   * @param contractId - The token contract address (`C...`).
   * @param networkPassphrase - Optional expected passphrase.
   * @returns The tracked token's contract ID and metadata.
   */
  async addToken(
    contractId: string,
    networkPassphrase?: string,
  ): Promise<AddTokenResult> {
    return this.invoke<AddTokenResult>('addToken', {
      contractId,
      ...(networkPassphrase ? { networkPassphrase } : {}),
    });
  }
}
