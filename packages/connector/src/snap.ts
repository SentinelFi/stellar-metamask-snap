import { getMetaMaskProvider, supportsSnaps } from './provider.js';
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
} from './types.js';
import { SEP43_ERROR_CODES, StellarSnapError } from './types.js';
import {
  isAddressResult,
  isAddTokenResult,
  isBalancesResult,
  isFundResult,
  isGetAccountsResult,
  isNetworkDetailsResult,
  isNetworkResult,
  isSetActiveAccountResult,
  isSignAuthEntryResult,
  isSignMessageResult,
  isSignTransactionResult,
} from './validate.js';

/** The published snap ID. */
export const DEFAULT_SNAP_ID = 'npm:stellar-soroban-snap';

/**
 * The default version requested at install time. Pinned to the exact audited
 * release (no semver range) so installs cannot silently pick up a newer,
 * unaudited version.
 */
export const DEFAULT_SNAP_VERSION = '0.1.0';

export type StellarSnapOptions = {
  /**
   * Snap ID; use `local:http://localhost:8080` during development. Must be
   * an `npm:` or `local:` ID; anything else is rejected at construction.
   */
  snapId?: string;
  /**
   * Version passed to `wallet_requestSnaps` (npm snaps only). Defaults to
   * the exact audited release. Must be an exact `x.y.z` semver; ranges are
   * rejected at construction because a range would silently defeat the
   * audited-release pin this constant exists to enforce.
   */
  version?: string;
  /** EIP-1193 provider; auto-detected via EIP-6963 when omitted. */
  provider?: Eip1193Provider;
  /** How long auto-detection waits for EIP-6963 announcements (ms). */
  discoveryTimeoutMs?: number;
};

/** An exact release version: `major.minor.patch`, no range operators. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/u;

/** Snap ID shapes the connector will request: npm-published or local dev. */
const SNAP_ID_PATTERN = /^(?:npm:|local:)./u;

/** Cap on error text copied from upstream into thrown errors. */
const MAX_ERROR_MESSAGE_LENGTH = 500;

/** The SEP-43 codes an error is allowed to carry into dapp logic. */
const KNOWN_SEP43_CODES = new Set<number>(Object.values(SEP43_ERROR_CODES));

/**
 * Normalizes provider/snap errors into `StellarSnapError` with SEP-43 codes.
 *
 * @param error - The raw error.
 * @returns The normalized error, ready to throw.
 */
function toStellarSnapError(error: unknown): StellarSnapError {
  const raw = error as {
    message?: unknown;
    code?: number;
    data?: {
      code?: unknown;
      signedTxXdr?: unknown;
      signerAddress?: unknown;
      hash?: unknown;
      status?: unknown;
    };
  };
  // Only the four SEP-43 codes pass through: dapps branch on these (`-4`
  // means "the user said no, do not retry"), so an arbitrary upstream number
  // must not be able to impersonate one. Anything else maps to internal.
  const rawCode = raw?.data?.code;
  const code =
    typeof rawCode === 'number' && KNOWN_SEP43_CODES.has(rawCode)
      ? rawCode
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
  // The message is upstream-controlled display text: require a string and
  // bound its length. Dapps must still render it as text, never as markup.
  const message =
    typeof raw?.message === 'string' && raw.message.length > 0
      ? raw.message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
      : 'Unknown error.';
  return new StellarSnapError(message, normalized, hasData ? data : undefined);
}

/**
 * Typed client for the Stellar Soroban MetaMask Snap. Methods mirror the
 * snap's SEP-0043 RPC surface and throw `StellarSnapError` on failure.
 */
export class StellarSnap {
  readonly snapId: string;

  readonly version: string;

  #provider: Eip1193Provider | null;

  #discovery: Promise<Eip1193Provider | null> | null = null;

  readonly #discoveryTimeoutMs: number | undefined;

  constructor(options: StellarSnapOptions = {}) {
    const snapId = options.snapId ?? DEFAULT_SNAP_ID;
    // Validated even though these are caller-supplied programmer inputs:
    // dapps routinely source them from config or env, which turns a typo or
    // a compromised variable into a silent unpin. A range in `version`
    // would defeat the exact-release pin; a snap ID outside npm:/local:
    // would request something this connector was never meant to install.
    if (!SNAP_ID_PATTERN.test(snapId)) {
      throw new TypeError(
        `Invalid snapId "${snapId}": expected an "npm:" or "local:" snap ID.`,
      );
    }
    const version = options.version ?? DEFAULT_SNAP_VERSION;
    if (!EXACT_SEMVER.test(version)) {
      throw new TypeError(
        `Invalid version "${version}": expected an exact semver (x.y.z). ` +
          'Ranges are rejected because they defeat the audited-release pin.',
      );
    }
    this.snapId = snapId;
    this.version = version;
    this.#provider = options.provider ?? null;
    this.#discoveryTimeoutMs = options.discoveryTimeoutMs;
  }

  /**
   * Resolves the provider, detecting MetaMask when not supplied. Concurrent
   * callers share one in-flight discovery instead of racing duplicates.
   *
   * @returns The provider.
   */
  async getProvider(): Promise<Eip1193Provider> {
    if (!this.#provider) {
      this.#discovery ??= getMetaMaskProvider(this.#discoveryTimeoutMs);
      try {
        this.#provider = await this.#discovery;
      } finally {
        this.#discovery = null;
      }
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
   * Reads the version of this snap that MetaMask reports as installed.
   *
   * @param snaps - The `wallet_getSnaps`/`wallet_requestSnaps` result.
   * @returns The installed version string, or null when the snap is absent
   * or the entry carries no readable version.
   */
  #installedVersion(snaps: unknown): string | null {
    if (typeof snaps !== 'object' || snaps === null) {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(snaps, this.snapId)) {
      return null;
    }
    const entry = (snaps as Record<string, { version?: unknown } | undefined>)[
      this.snapId
    ];
    return typeof entry?.version === 'string' ? entry.version : null;
  }

  /**
   * Whether this snap is installed at the pinned version.
   *
   * For `npm:` snap IDs the installed version must equal the pin: an
   * installed-but-different version is reported as not installed, because
   * every call this client would make against it runs code other than the
   * release the pin names. Local development snaps carry no meaningful
   * version and only need to be present.
   *
   * @returns True when installed (and, for npm snaps, at the pinned
   * version).
   */
  async isInstalled(): Promise<boolean> {
    try {
      const provider = await this.getProvider();
      const snaps = await provider.request({ method: 'wallet_getSnaps' });
      const installed = this.#installedVersion(snaps);
      if (!this.snapId.startsWith('npm:')) {
        return (
          typeof snaps === 'object' &&
          snaps !== null &&
          Object.prototype.hasOwnProperty.call(snaps, this.snapId)
        );
      }
      return installed === this.version;
    } catch {
      return false;
    }
  }

  /**
   * Installs (or reconnects) the snap and requests wallet access.
   *
   * The `wallet_requestSnaps` result is verified, not assumed: MetaMask may
   * keep an already-installed copy rather than installing the requested
   * version, and every later call would then run code other than the pinned
   * release. A version mismatch fails here, before any signing surface is
   * touched.
   *
   * @returns The wallet address.
   */
  async connect(): Promise<GetAddressResult> {
    const provider = await this.getProvider();
    let result: unknown;
    try {
      result = await provider.request({
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
    if (this.snapId.startsWith('npm:')) {
      const installed = this.#installedVersion(result);
      if (installed !== this.version) {
        throw new StellarSnapError(
          `MetaMask reports snap version ${
            installed === null ? 'unknown' : installed.slice(0, 32)
          } installed, but this client pins ${this.version}. ` +
            'Update the snap or the dapp before continuing.',
          SEP43_ERROR_CODES.invalidRequest,
        );
      }
    }
    return this.requestAccess();
  }

  /**
   * Invokes a snap RPC method and returns the raw, unvalidated result.
   *
   * This is the escape hatch for methods this client has no typed wrapper
   * for. It deliberately returns `unknown`: the response crosses the
   * provider boundary, and the typed methods below only earn their types by
   * validating shapes. Callers of the raw form take on that job themselves.
   *
   * @param method - The snap method name.
   * @param params - Optional params object.
   * @returns The raw method result.
   */
  async invoke(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const provider = await this.getProvider();
    try {
      return await provider.request({
        method: 'wallet_invokeSnap',
        params: {
          snapId: this.snapId,
          request: params ? { method, params } : { method },
        },
      });
    } catch (error) {
      throw toStellarSnapError(error);
    }
  }

  /**
   * Invokes a snap RPC method and validates the response shape.
   *
   * Every typed public method funnels through here: the provider object is
   * discovered from the page environment, so a result must prove it has the
   * documented shape before dapp code receives it as a validated value. A
   * mismatch is an internal error, not a cast.
   *
   * @param method - The snap method name.
   * @param params - Optional params object.
   * @param validateResult - Structural validator for the expected shape.
   * @returns The validated method result.
   */
  async #invoke<Type>(
    method: string,
    params: Record<string, unknown> | undefined,
    validateResult: (value: unknown) => value is Type,
  ): Promise<Type> {
    const result = await this.invoke(method, params);
    if (!validateResult(result)) {
      throw new StellarSnapError(
        `The wallet returned an unexpected response shape for ${method}.`,
        SEP43_ERROR_CODES.internal,
      );
    }
    return result;
  }

  /**
   * SEP-43 `requestAccess`: connect dialog on first use.
   *
   * @returns The wallet address.
   */
  async requestAccess(): Promise<GetAddressResult> {
    return this.#invoke('requestAccess', undefined, isAddressResult);
  }

  /**
   * SEP-43 `getAddress`: silent; empty string when not granted.
   *
   * @returns The wallet address or `{ address: '' }`.
   */
  async getAddress(): Promise<GetAddressResult> {
    return this.#invoke('getAddress', undefined, isAddressResult);
  }

  /**
   * SEP-43 `getNetwork`.
   *
   * @returns The active network and passphrase.
   */
  async getNetwork(): Promise<NetworkResult> {
    return this.#invoke('getNetwork', undefined, isNetworkResult);
  }

  /**
   * Freighter-compatible `getNetworkDetails`.
   *
   * @returns Network, passphrase, Horizon URL, Soroban RPC URL.
   */
  async getNetworkDetails(): Promise<NetworkDetailsResult> {
    return this.#invoke('getNetworkDetails', undefined, isNetworkDetailsResult);
  }

  /**
   * Switches the active network (dialog-confirmed).
   *
   * @param network - Target network name.
   * @returns The new network details.
   */
  async setNetwork(network: NetworkName): Promise<NetworkDetailsResult> {
    return this.#invoke('setNetwork', { network }, isNetworkDetailsResult);
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
    return this.#invoke(
      'signTransaction',
      { xdr, ...options },
      isSignTransactionResult,
    );
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
    return this.#invoke(
      'signAuthEntry',
      { authEntry, ...options },
      isSignAuthEntryResult,
    );
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
    return this.#invoke(
      'signMessage',
      { message, ...options },
      isSignMessageResult,
    );
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
    return this.#invoke('getAccounts', undefined, isGetAccountsResult);
  }

  /**
   * Switches the wallet-global active account (dialog-confirmed; requires a
   * connected origin). Only accounts the user has revealed can be activated.
   *
   * @param index - The SEP-0005 account index to activate.
   * @returns The new active account.
   */
  async setActiveAccount(index: number): Promise<SetActiveAccountResult> {
    return this.#invoke(
      'setActiveAccount',
      { index },
      isSetActiveAccountResult,
    );
  }

  /**
   * Friendbot funding (test networks; requires a connected origin).
   *
   * @param address - Optional address; defaults to the wallet account.
   * @returns The funded address.
   */
  async fund(address?: string): Promise<FundResult> {
    return this.#invoke('fund', address ? { address } : {}, isFundResult);
  }

  /**
   * Balances + sequence via Horizon, plus tracked Soroban token balances
   * (requires a connected origin). Like `fund`, only the wallet's own
   * accounts may be queried.
   *
   * @param address - Optional address; must be one of the wallet's revealed
   * accounts. Defaults to the active account.
   * @returns The account summary.
   */
  async getBalances(address?: string): Promise<BalancesResult> {
    return this.#invoke(
      'getBalances',
      address ? { address } : {},
      isBalancesResult,
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
    return this.#invoke(
      'addToken',
      {
        contractId,
        ...(networkPassphrase ? { networkPassphrase } : {}),
      },
      isAddTokenResult,
    );
  }
}
