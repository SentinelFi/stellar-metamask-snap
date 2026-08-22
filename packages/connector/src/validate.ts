import type {
  AddTokenResult,
  BalancesResult,
  FundResult,
  GetAccountsResult,
  GetAddressResult,
  NetworkDetailsResult,
  NetworkResult,
  SetActiveAccountResult,
  SignAuthEntryResult,
  SignMessageResult,
  SignTransactionResultWithWarnings,
} from './types.js';

/**
 * Structural validators for snap RPC responses.
 *
 * The snap is trusted code, but its responses reach the dapp through the
 * wallet provider, and the provider object itself is discovered from the
 * page environment. The whole point of this typed client is that the types
 * it hands to dapp code are checked, not asserted: a blind `as Type` cast
 * would let any upstream party shape a value that the dapp then treats as a
 * validated address, envelope, or balance. Each validator below admits
 * exactly the fields the public API documents.
 *
 * Hand-rolled predicates (no schema library) keep the package's
 * zero-runtime-dependency property.
 */

/**
 * Whether a value is a plain object (arrays excluded).
 *
 * @param value - The value to test.
 * @returns True for non-null, non-array objects.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a value is a string.
 *
 * @param value - The value to test.
 * @returns True for strings.
 */
const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Shape predicates for the values the snap reports. Every string the typed
 * API hands to dapp code is either a strkey, a hash, a base64 payload, an
 * enumerated status, or bounded display text; a value outside those shapes
 * did not come from the pinned snap release, and a dapp that renders or
 * forwards it should not receive it as a validated one. The bounds are
 * generous for real traffic and tight against a captured provider feeding a
 * page a multi-megabyte "warning" or a signer address that is not a key.
 */

/** A classic `G...` ed25519 account address. */
const ACCOUNT_ADDRESS = /^G[A-Z2-7]{55}$/u;

/** A Soroban `C...` contract address. */
const CONTRACT_ADDRESS = /^C[A-Z2-7]{55}$/u;

/** A 64-character hex transaction hash. */
const TRANSACTION_HASH = /^[0-9a-f]{64}$/iu;

/** Base64 text (standard alphabet, optional padding). */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/**
 * The submission statuses the snap can report: the Soroban RPC's status
 * enumeration. A result carries `PENDING` or `DUPLICATE` (the accepted
 * states); the failure states can appear on recovery data.
 */
const SUBMISSION_STATUSES = new Set([
  'PENDING',
  'DUPLICATE',
  'TRY_AGAIN_LATER',
  'ERROR',
]);

/** Largest signed payload (envelope, auth entry, or signature) accepted. */
const MAX_PAYLOAD_LENGTH = 512 * 1024;

/** Caps on the advisory warnings a signing result may carry. */
const MAX_WARNINGS = 16;
const MAX_WARNING_LENGTH = 512;

/** Bounds on the self-reported token metadata `addToken` returns. */
const MAX_SYMBOL_LENGTH = 32;
const MAX_DECIMALS = 255;

/** A bounded decimal amount: digits with an optional fraction. */
const DECIMAL_AMOUNT = /^-?\d{1,40}(\.\d{1,40})?$/u;

/** Largest display label (`CODE:ISSUER`, `SYMBOL:CONTRACT`) accepted. */
const MAX_ASSET_LABEL_LENGTH = 128;

/**
 * Whether a value is an account address.
 *
 * @param value - The value to test.
 * @returns True for a `G...` strkey.
 */
const isAccountAddress = (value: unknown): value is string =>
  isString(value) && ACCOUNT_ADDRESS.test(value);

/**
 * Whether a value is a base64 payload within the size bound.
 *
 * @param value - The value to test.
 * @returns True for bounded base64 text.
 */
const isPayload = (value: unknown): value is string =>
  isString(value) &&
  value.length > 0 &&
  value.length <= MAX_PAYLOAD_LENGTH &&
  BASE64.test(value);

/**
 * Whether a value is a transaction hash or absent.
 *
 * @param value - The value to test.
 * @returns True for undefined or a 64-hex hash.
 */
const isOptionalHash = (value: unknown): value is string | undefined =>
  value === undefined || (isString(value) && TRANSACTION_HASH.test(value));

/**
 * Whether a value is a known submission status or absent.
 *
 * @param value - The value to test.
 * @returns True for undefined or an enumerated status.
 */
const isOptionalStatus = (value: unknown): value is string | undefined =>
  value === undefined || (isString(value) && SUBMISSION_STATUSES.has(value));

/**
 * Whether a value is a bounded list of bounded warning strings, or absent.
 *
 * @param value - The value to test.
 * @returns True for undefined or a conforming array.
 */
const isOptionalWarnings = (value: unknown): value is string[] | undefined =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length <= MAX_WARNINGS &&
    value.every(
      (entry) => isString(entry) && entry.length <= MAX_WARNING_LENGTH,
    ));

/**
 * The passphrase and endpoints the snap can report for each network, pinned
 * exactly.
 *
 * The snap resolves these from a hardcoded constant table, so a network
 * result carrying any other value did not come from the pinned snap release:
 * it came from whatever answered the provider request. Pinning them here
 * costs nothing for a legitimate response and closes the channel where a
 * spoofed provider labels one network with another's passphrase, or hands a
 * dapp an endpoint URL it then fetches account state from. Kept in step with
 * the snap's `state/networks.ts` by the release process, like the version
 * pin itself.
 */
const KNOWN_NETWORKS: Record<
  string,
  { networkPassphrase: string; networkUrl: string; sorobanRpcUrl: string }
> = {
  PUBLIC: {
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    networkUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
  },
  TESTNET: {
    networkPassphrase: 'Test SDF Network ; September 2015',
    networkUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  },
  FUTURENET: {
    networkPassphrase: 'Test SDF Future Network ; October 2022',
    networkUrl: 'https://horizon-futurenet.stellar.org',
    sorobanRpcUrl: 'https://rpc-futurenet.stellar.org',
  },
};

/**
 * The pinned constants for a reported network name, or undefined when the
 * name is not one of the snap's networks. Own-property lookup, so an
 * inherited key such as `constructor` cannot resolve to a value.
 *
 * @param value - The reported network name.
 * @returns The pinned constants, or undefined.
 */
const knownNetwork = (
  value: unknown,
):
  | { networkPassphrase: string; networkUrl: string; sorobanRpcUrl: string }
  | undefined =>
  typeof value === 'string' &&
  Object.prototype.hasOwnProperty.call(KNOWN_NETWORKS, value)
    ? KNOWN_NETWORKS[value]
    : undefined;

/**
 * Validates a `{ address }` result.
 *
 * @param value - The raw response.
 * @returns True when the shape matches.
 */
export const isAddressResult = (value: unknown): value is GetAddressResult =>
  // Empty is the documented "not connected" answer; anything else must be an
  // account address.
  isRecord(value) && (value.address === '' || isAccountAddress(value.address));

/**
 * Validates a `getNetwork` result: a known network name carrying exactly
 * that network's passphrase.
 *
 * @param value - The raw response.
 * @returns True when the shape matches.
 */
export const isNetworkResult = (value: unknown): value is NetworkResult => {
  if (!isRecord(value)) {
    return false;
  }
  const known = knownNetwork(value.network);
  return (
    known !== undefined && value.networkPassphrase === known.networkPassphrase
  );
};

/**
 * Validates a `getNetworkDetails`/`setNetwork` result: the passphrase and
 * both endpoint URLs must be the pinned values for the reported network.
 *
 * @param value - The raw response.
 * @returns True when the shape matches.
 */
export const isNetworkDetailsResult = (
  value: unknown,
): value is NetworkDetailsResult => {
  if (!isRecord(value)) {
    return false;
  }
  const known = knownNetwork(value.network);
  return (
    known !== undefined &&
    value.networkPassphrase === known.networkPassphrase &&
    value.networkUrl === known.networkUrl &&
    value.sorobanRpcUrl === known.sorobanRpcUrl
  );
};

/**
 * Validates a `signTransaction` result.
 *
 * @param value - The raw response.
 * @returns True when the shape matches.
 */
export const isSignTransactionResult = (
  value: unknown,
): value is SignTransactionResultWithWarnings =>
  isRecord(value) &&
  isPayload(value.signedTxXdr) &&
  isAccountAddress(value.signerAddress) &&
  isOptionalHash(value.hash) &&
  isOptionalStatus(value.status) &&
  isOptionalWarnings(value.warnings);

/**
 * Validates a `signAuthEntry` result.
 *
 * @param value - The raw response.
 * @returns True when the shape matches.
 */
export const isSignAuthEntryResult = (
  value: unknown,
): value is SignAuthEntryResult =>
  isRecord(value) &&
  isPayload(value.signedAuthEntry) &&
  isAccountAddress(value.signerAddress);

/**
 * Validates a `signMessage` result.
 *
 * @param value - The raw response.
 * @returns True when the shape matches.
 */
export const isSignMessageResult = (
  value: unknown,
): value is SignMessageResult =>
  isRecord(value) &&
  isPayload(value.signedMessage) &&
  isAccountAddress(value.signerAddress);

/**
 * Validates one revealed-account entry.
 *
 * @param value - The raw entry.
 * @returns True when the shape matches.
 */
const isAccountInfo = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.index === 'number' &&
  Number.isInteger(value.index) &&
  value.index >= 0 &&
  isAccountAddress(value.address);

/**
 * Validates a `getAccounts` result.
 *
 * @param value - The raw response.
 * @returns True when the shape matches.
 */
export const isGetAccountsResult = (
  value: unknown,
): value is GetAccountsResult =>
  isRecord(value) &&
  Array.isArray(value.accounts) &&
  value.accounts.every(isAccountInfo) &&
  typeof value.activeIndex === 'number' &&
  Number.isInteger(value.activeIndex);

/**
 * Validates a `setActiveAccount` result.
 *
 * @param value - The raw response.
 * @returns True when the shape matches.
 */
export const isSetActiveAccountResult = (
  value: unknown,
): value is SetActiveAccountResult => isAccountInfo(value);

/**
 * Validates a `fund` result.
 *
 * @param value - The raw response.
 * @returns True when the shape matches.
 */
export const isFundResult = (value: unknown): value is FundResult =>
  isRecord(value) && value.funded === true && isAccountAddress(value.address);

/**
 * Validates one balance row.
 *
 * `type` is required, not optional. It is the field that tells a classic
 * `CODE:ISSUER` row apart from a Soroban `SYMBOL:CONTRACT_ID` one, and a
 * validator that admitted rows without it would let callers keep writing the
 * `asset.split(':')` code the field exists to retire, silently, against a
 * symbol the token contract chose. `contractId` is required exactly when the
 * row is a token, for the same reason.
 *
 * @param value - The raw row.
 * @returns True when the shape matches.
 */
const isBalanceLine = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !isString(value.asset) ||
    value.asset.length === 0 ||
    value.asset.length > MAX_ASSET_LABEL_LENGTH ||
    !isString(value.balance) ||
    !DECIMAL_AMOUNT.test(value.balance)
  ) {
    return false;
  }
  if (value.type === 'soroban') {
    return (
      isString(value.contractId) && CONTRACT_ADDRESS.test(value.contractId)
    );
  }
  return (
    (value.type === 'native' ||
      value.type === 'classic' ||
      value.type === 'pool') &&
    value.contractId === undefined
  );
};

/**
 * Validates a `getBalances` result.
 *
 * @param value - The raw response.
 * @returns True when the shape matches.
 */
export const isBalancesResult = (value: unknown): value is BalancesResult =>
  isRecord(value) &&
  isAccountAddress(value.address) &&
  typeof value.funded === 'boolean' &&
  (value.sequence === null ||
    (isString(value.sequence) && /^\d{1,30}$/u.test(value.sequence))) &&
  Array.isArray(value.balances) &&
  value.balances.every(isBalanceLine) &&
  // Absent or exactly `true`. Admitting `false` would give each flag two
  // spellings for "nothing was omitted" and invite negated checks that read
  // the wrong one.
  (value.tokensUnavailable === undefined || value.tokensUnavailable === true) &&
  (value.balancesTruncated === undefined || value.balancesTruncated === true);

/**
 * Validates an `addToken` result.
 *
 * @param value - The raw response.
 * @returns True when the shape matches.
 */
export const isAddTokenResult = (value: unknown): value is AddTokenResult =>
  isRecord(value) &&
  isString(value.contractId) &&
  CONTRACT_ADDRESS.test(value.contractId) &&
  isString(value.symbol) &&
  value.symbol.length > 0 &&
  value.symbol.length <= MAX_SYMBOL_LENGTH &&
  typeof value.decimals === 'number' &&
  Number.isInteger(value.decimals) &&
  value.decimals >= 0 &&
  value.decimals <= MAX_DECIMALS;

/**
 * Bounds the recovery fields an error may carry (`snap.ts` copies them from
 * the upstream error's `data`). The same shapes as the success results: a
 * field that does not fit is dropped on its own, so a malformed `status`
 * cannot take the signed envelope down with it.
 *
 * @param key - The recovery field name.
 * @param value - The raw value.
 * @returns True when the value has the field's documented shape.
 */
export const isRecoveryField = (
  key: 'signedTxXdr' | 'signerAddress' | 'hash' | 'status',
  value: unknown,
): value is string => {
  switch (key) {
    case 'signedTxXdr':
      return isPayload(value);
    case 'signerAddress':
      return isAccountAddress(value);
    case 'hash':
      return isString(value) && TRANSACTION_HASH.test(value);
    case 'status':
      return isString(value) && SUBMISSION_STATUSES.has(value);
    default:
      return false;
  }
};
