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
  isRecoveryField,
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
  // caller can poll or retry after an ambiguous submission failure. Each
  // field is shape-checked like the success results are, and a field that
  // does not fit is dropped on its own rather than taking the others with
  // it: the `message` below is bounded, and text a dapp renders from
  // `error.data` must be no less so.
  const data: StellarSnapErrorData = {};
  for (const key of [
    'signedTxXdr',
    'signerAddress',
    'hash',
    'status',
  ] as const) {
    const value = raw?.data?.[key];
    if (isRecoveryField(key, value)) {
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
   * Counts the demands for a *fresh* version comparison. Bumped whenever a
   * non-read-only call drops the memo, and stamped onto every lookup when it
   * starts. Only a lookup begun in the current generation may mark the pin
   * verified or be awaited as the fresh check: without the stamp, a call that
   * cleared the memo could still be satisfied by a `wallet_getSnaps` read
   * that started (and observed the installed version) before the call was
   * made, which is exactly the staleness dropping the memo exists to refuse.
   */
  #versionGeneration = 0;

  /**
   * The in-flight lazy version check, shared so that concurrent first calls
   * (a page that fires `getAddress()` and `getNetwork()` together) read
   * `wallet_getSnaps` once rather than once each. Tagged with the generation
   * it was started in; a caller from a newer generation starts its own
   * lookup instead of reusing this one.
   */
  #versionCheck: { generation: number; promise: Promise<void> } | null = null;

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
   * Whether the version MetaMask reports is the pinned one.
   *
   * @param installed - The version MetaMask reported.
   * @returns True when it equals the pin.
   */
  #matchesPin(installed: string | null): boolean {
    return installed === this.version;
  }

  /**
   * Opens a new check generation, so the next `#ensurePinnedVersion` performs
   * (and awaits) a `wallet_getSnaps` read begun *after* this moment rather
   * than reusing any earlier lookup.
   */
  #requireFreshVersionCheck(): void {
    this.#versionGeneration += 1;
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
   * This is the discovery path, and it answers a question rather than
   * authorising anything: a true answer is never carried forward to satisfy
   * a later invocation's version check. Every invocation performs its own
   * comparison at the moment it is made (see `invoke()`), because the only
   * thing that can be verified about a bundle is the version installed *now*.
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
      return this.#matchesPin(this.#installedVersion(snaps));
    } catch {
      return false;
    }
  }

  /**
   * Verifies, on every invocation, that the snap MetaMask will route
   * `wallet_invokeSnap` to is the pinned release.
   *
   * `connect()` already verifies what `wallet_requestSnaps` installed, but a
   * dapp is not obliged to call it first: `getAddress()` is silent by
   * design, the Freighter facade's `isAllowed()` and the Wallets Kit's
   * `getAddress({ skipRequestAccess: true })` reach the typed methods
   * directly, and the common "read the address, connect only if it is
   * empty" pattern would otherwise run every call against whatever release
   * happens to be installed under the published ID, with no one having
   * compared it to the pin. This closes that gap: every invocation on an
   * `npm:` client reads `wallet_getSnaps`, and a mismatch is refused with
   * the same error `connect()` throws.
   *
   * Nothing is remembered between calls. An earlier successful comparison
   * describes the bundle that was installed then, and MetaMask can replace
   * it under the same npm ID at any point in a page's life; a replacement
   * inherits the snap's granted permissions and controls its own dispatcher,
   * so it is not constrained by the method name the caller asked for. There
   * is therefore no class of call for which a previous check can vouch, and
   * no memo to trust.
   *
   * An absent entry is refused rather than deferred to MetaMask. Letting the
   * invocation proceed and relying on the wallet to reject it is fine for a
   * caller probing before installation, but it cannot support an exact
   * version guarantee during an install or update race, where the entry can
   * appear between this read and the invocation. Callers that want discovery
   * semantics use `isInstalled()`.
   *
   * A call opens a new generation, and only a lookup begun in that generation
   * may answer it: an in-flight `wallet_getSnaps` read that started earlier
   * observed the installed version before this call was made, so reusing it
   * would let a snap updated in between slip past the check. Such a call
   * starts its own lookup; waiters from the older generation keep theirs. The
   * converse, a lookup that is superseded by a *later* generation while it
   * is in flight, is handled by `#ensureCurrentPinnedVersion`.
   *
   * @param provider - The resolved provider.
   */
  async #ensurePinnedVersion(provider: Eip1193Provider): Promise<void> {
    const generation = this.#versionGeneration;
    let check = this.#versionCheck;
    if (check === null || check.generation !== generation) {
      const promise = (async () => {
        let snaps: unknown;
        try {
          snaps = await provider.request({ method: 'wallet_getSnaps' });
        } catch (error) {
          throw toStellarSnapError(error);
        }
        const installed = this.#installedVersion(snaps);
        if (!this.#matchesPin(installed)) {
          throw this.#versionMismatchError(installed);
        }
      })();
      check = { generation, promise };
      this.#versionCheck = check;
    }
    try {
      await check.promise;
    } finally {
      // Clear only what this caller awaited: a newer generation may already
      // have installed its own lookup here.
      if (this.#versionCheck === check) {
        this.#versionCheck = null;
      }
    }
  }

  /**
   * The comparison every invocation takes: demands a new generation, then
   * awaits a lookup until the one it awaited is still the newest demand at
   * the moment it settles.
   *
   * `#ensurePinnedVersion` answers each caller with the lookup of the
   * generation that caller captured. That is correct for the caller's own
   * demand, but two calls can overlap: the second opens a newer generation
   * while the first's lookup is in flight, and if the newer lookup is the
   * one that notices an update, the first call would still proceed on its
   * own, older, success. A call whose generation has been superseded repeats
   * the check for the current generation, sharing the in-flight lookup when
   * there is one, and invokes only on a result no later demand has
   * outdated. Recursive rather than looped so each repeat is one plain
   * await; it terminates because every repeat awaits a generation that is
   * strictly newer than the last, and generations are only opened by calls.
   *
   * @param provider - The resolved provider.
   */
  async #ensureCurrentPinnedVersion(provider: Eip1193Provider): Promise<void> {
    const generation = this.#versionGeneration;
    await this.#ensurePinnedVersion(provider);
    if (generation !== this.#versionGeneration) {
      await this.#ensureCurrentPinnedVersion(provider);
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
      if (!this.#matchesPin(installed)) {
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
   * `npm:` snap every invocation confirms that the installed release is the
   * pinned one (see `#ensurePinnedVersion`), so even the raw path cannot
   * quietly talk to a different release than the one this client names. The
   * method name is arbitrary here, so the per-page memo is trusted only for
   * the public-read allowlist; any other name - a signing method, a
   * mutation, a connected privacy read, or something this connector has
   * never heard of - drops the memo and is compared against a
   * `wallet_getSnaps` read begun after this call was made and not outdated
   * by a later one. MetaMask can update the snap under the same npm ID while
   * the page stays open, and a raw signing call must not run against a
   * release the page never compared to the pin.
   *
   * The typed wrappers funnel through here, so the same classification
   * governs them: `signTransaction` and its peers, the dialog-confirmed
   * mutations, the dialog-free `fund`, and the address, account and balance
   * reads all take the fresh check; only the network reads answer from the
   * memo. One extra provider read on a call that produces a signature,
   * changes wallet state, or discloses wallet data is noise, and a
   * mid-session update fails closed with the same version-mismatch error
   * `connect()` throws.
   *
   * The check and the invocation are two provider requests, not one.
   * `wallet_invokeSnap` carries no version parameter, so a snap the user
   * updates in the instant between the `wallet_getSnaps` read settling and
   * the invocation being dispatched is the release that answers. That is the
   * shape of MetaMask's API rather than a gap in this client's ordering:
   * every check here is as fresh as a separate read can be, and no fresher.
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
    if (this.snapId.startsWith('npm:')) {
      this.#requireFreshVersionCheck();
      await this.#ensureCurrentPinnedVersion(provider);
    }
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
   * Silent towards the user, but not public: it discloses the wallet's
   * address, so like `getAccounts` and `getBalances` it is compared against
   * the pinned version with a fresh `wallet_getSnaps` read on every call
   * rather than answering from the per-page memo (see `invoke()`).
   *
   * @returns The wallet address or `{ address: '' }`.
   */
  async getAddress(): Promise<GetAddressResult> {
    return this.#invoke('getAddress', undefined, isAddressResult);
  }

  /**
   * SEP-43 `getNetwork`.
   *
   * A public read: the snap answers it for any origin, and it discloses
   * nothing about the wallet beyond its network preference. It and
   * `getNetworkDetails` are the only calls that answer from the per-page
   * version memo once it is verified (see `invoke()`).
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
   * Side-effecting and dialog-free, so it is not on the read-only allowlist:
   * like the signing methods, each call is compared against the pinned
   * version with a fresh `wallet_getSnaps` read rather than the per-page
   * memo (see `invoke()`).
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
