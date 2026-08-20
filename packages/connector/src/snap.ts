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

/**
 * An exact release version: `major.minor.patch`, no range operators and no
 * prerelease or build suffix. Prereleases are refused on purpose: the pin
 * names an audited release, and `1.2.3-beta.1` is not one.
 *
 * The companion site's production build guard (`packages/site/gatsby-node.js`,
 * `EXACT_VERSION`) applies the same rule to `GATSBY_SNAP_VERSION`, so a value
 * the build accepts is a value this constructor accepts. Keep the two in
 * step: a value that passes the build but fails here would throw the moment
 * the page constructs its client.
 */
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

  /**
   * Whether MetaMask has been seen to report the pinned version installed
   * under `snapId`. Set by `connect()` and `isInstalled()` when they verify
   * it, or by the lazy check in `invoke()` otherwise; cleared whenever a
   * check fails, so the next call re-reads `wallet_getSnaps` rather than
   * trusting a stale answer. Always true for `local:` IDs, which carry no
   * meaningful version.
   */
  #versionVerified: boolean;

  /**
   * The in-flight lazy version check, shared so that concurrent first calls
   * (a page that fires `getAddress()` and `getNetwork()` together) read
   * `wallet_getSnaps` once rather than once each.
   */
  #versionCheck: Promise<void> | null = null;

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
    // Any `npm:` ID passes the shape check, including a package that merely
    // resembles the published snap. That is deliberate (a fork under test
    // is a legitimate target) but it must not happen quietly: the
    // audited-release pin, the version verification, and every statement
    // in the documentation describe `DEFAULT_SNAP_ID`, and a dapp that was
    // handed a different ID through config or env should see that in its
    // console rather than discover it from a user.
    if (snapId.startsWith('npm:') && snapId !== DEFAULT_SNAP_ID) {
      console.warn(
        `StellarSnap: snapId "${snapId}" is not the published snap ` +
          `(${DEFAULT_SNAP_ID}). The audited-release pin and this ` +
          `connector's guarantees apply only to the published snap; make ` +
          `sure this is intentional.`,
      );
    }
    this.snapId = snapId;
    this.version = version;
    this.#provider = options.provider ?? null;
    this.#discoveryTimeoutMs = options.discoveryTimeoutMs;
    this.#versionVerified = !snapId.startsWith('npm:');
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
    if (!this.#hasEntry(snaps)) {
      return null;
    }
    const entry = (snaps as Record<string, { version?: unknown } | undefined>)[
      this.snapId
    ];
    return typeof entry?.version === 'string' ? entry.version : null;
  }

  /**
   * Whether a `wallet_getSnaps`/`wallet_requestSnaps` result lists this snap
   * at all, whatever version it reports.
   *
   * @param snaps - The provider result.
   * @returns True when the map has an own entry for `snapId`.
   */
  #hasEntry(snaps: unknown): boolean {
    return (
      typeof snaps === 'object' &&
      snaps !== null &&
      Object.prototype.hasOwnProperty.call(snaps, this.snapId)
    );
  }

  /**
   * The error thrown whenever MetaMask reports a version of this snap other
   * than the pinned one. Shared by `connect()` and the lazy check in
   * `invoke()` so a dapp sees one message and one code for the condition
   * regardless of which call surfaced it.
   *
   * @param installed - The version MetaMask reported, or null when the entry
   * carried no readable version.
   * @returns The error, ready to throw.
   */
  #versionMismatchError(installed: string | null): StellarSnapError {
    return new StellarSnapError(
      `MetaMask reports snap version ${
        installed === null ? 'unknown' : installed.slice(0, 32)
      } installed, but this client pins ${this.version}. ` +
        'Update the snap or the dapp before continuing.',
      SEP43_ERROR_CODES.invalidRequest,
    );
  }

  /**
   * Records the outcome of a version comparison for an `npm:` snap, so that
   * a verified pin is not re-read on every call and a failed comparison is
   * not remembered past the call that observed it.
   *
   * @param installed - The version MetaMask reported.
   * @returns True when it equals the pin.
   */
  #recordVersion(installed: string | null): boolean {
    this.#versionVerified = installed === this.version;
    return this.#versionVerified;
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
   * A true answer for an `npm:` ID also satisfies the per-call version
   * check in `invoke()`, so a dapp that asks this first pays for one
   * `wallet_getSnaps` read, not two.
   *
   * @returns True when installed (and, for npm snaps, at the pinned
   * version).
   */
  async isInstalled(): Promise<boolean> {
    try {
      const provider = await this.getProvider();
      const snaps = await provider.request({ method: 'wallet_getSnaps' });
      if (!this.snapId.startsWith('npm:')) {
        return this.#hasEntry(snaps);
      }
      return this.#recordVersion(this.#installedVersion(snaps));
    } catch {
      return false;
    }
  }

  /**
   * Verifies, at most once per client for the happy path, that the snap
   * MetaMask will route `wallet_invokeSnap` to is the pinned release.
   *
   * `connect()` already verifies what `wallet_requestSnaps` installed, but a
   * dapp is not obliged to call it first: `getAddress()` is silent by
   * design, the Freighter facade's `isAllowed()` and the Wallets Kit's
   * `getAddress({ skipRequestAccess: true })` reach the typed methods
   * directly, and the common "read the address, connect only if it is
   * empty" pattern would otherwise run every call against whatever release
   * happens to be installed under the published ID, with no one having
   * compared it to the pin. This closes that gap: the first invocation on
   * an `npm:` client reads `wallet_getSnaps`, a mismatch is refused with the
   * same error `connect()` throws, and a match is remembered so later calls
   * cost nothing extra.
   *
   * An absent snap is not an error here. MetaMask refuses the invocation
   * itself in that case, and letting it do so keeps the behaviour a dapp
   * already handles (and the way `getAddress()` fails before installation)
   * unchanged. Nothing is remembered for that outcome either, so the check
   * simply repeats until the snap is installed and compared.
   *
   * The memo is per client instance and is not re-read while the page is
   * open: a user who updates the snap mid-session is the one case it does
   * not see, and `connect()` re-verifies whenever a dapp asks it to.
   *
   * @param provider - The resolved provider.
   */
  async #ensurePinnedVersion(provider: Eip1193Provider): Promise<void> {
    if (this.#versionVerified) {
      return;
    }
    this.#versionCheck ??= (async () => {
      let snaps: unknown;
      try {
        snaps = await provider.request({ method: 'wallet_getSnaps' });
      } catch (error) {
        throw toStellarSnapError(error);
      }
      if (!this.#hasEntry(snaps)) {
        return;
      }
      const installed = this.#installedVersion(snaps);
      if (!this.#recordVersion(installed)) {
        throw this.#versionMismatchError(installed);
      }
    })();
    try {
      await this.#versionCheck;
    } finally {
      this.#versionCheck = null;
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
      if (!this.#recordVersion(installed)) {
        throw this.#versionMismatchError(installed);
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
   * What it does share with the typed methods is the version check: for an
   * `npm:` snap the first invocation confirms that the installed release is
   * the pinned one (see `#ensurePinnedVersion`), so even the raw path cannot
   * quietly talk to a different release than the one this client names.
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
    await this.#ensurePinnedVersion(provider);
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
   * `options.submitUrl` is refused here with `-3` rather than forwarded or
   * dropped: the snap submits only to its own allowlisted endpoints, and a
   * caller that named another one must learn that its endpoint was not used
   * (see {@link SignTransactionOptions.submitUrl}).
   *
   * @param xdr - Base64 transaction envelope XDR.
   * @param options - Optional SEP-43 option bag.
   * @returns The signed envelope and signer address.
   */
  async signTransaction(
    xdr: string,
    options: SignTransactionOptions = {},
  ): Promise<SignTransactionResultWithWarnings> {
    if (options.submitUrl !== undefined) {
      throw new StellarSnapError(
        'Custom submission endpoints (submitUrl) are not supported: the ' +
          'wallet submits only to its own allowlisted Horizon and Soroban ' +
          'RPC endpoints. Omit submitUrl, or set submit: false and ' +
          'broadcast the signed envelope yourself.',
        SEP43_ERROR_CODES.invalidRequest,
      );
    }
    // The positional argument is placed after the spread in each signing
    // method so an option bag that happens to carry the same key (`xdr`,
    // `authEntry`, `message`) cannot replace what the caller passed by
    // position. Option bags are routinely forwarded from other layers (a
    // kit, a facade, a dapp's own config), and "the payload I named wins"
    // is the only rule a caller can reason about.
    return this.#invoke(
      'signTransaction',
      { ...options, xdr },
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
      { ...options, authEntry },
      isSignAuthEntryResult,
    );
  }

  /**
   * SEP-43 `signMessage` (SEP-53).
   *
   * @param message - The message to sign.
   * @param options - Optional SEP-43 option bag (`address`, and
   * `networkPassphrase`, which is checked against the wallet's network when
   * present).
   * @returns The base64 signature and signer address.
   */
  async signMessage(
    message: string,
    options: SignMessageOptions = {},
  ): Promise<SignMessageResult> {
    return this.#invoke(
      'signMessage',
      { ...options, message },
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
