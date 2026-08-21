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
 * Whether a value is a string or absent.
 *
 * @param value - The value to test.
 * @returns True for strings and undefined.
 */
const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

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
  isRecord(value) && isString(value.address);

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
  isString(value.signedTxXdr) &&
  isString(value.signerAddress) &&
  isOptionalString(value.hash) &&
  isOptionalString(value.status) &&
  (value.warnings === undefined ||
    (Array.isArray(value.warnings) && value.warnings.every(isString)));

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
  isString(value.signedAuthEntry) &&
  isString(value.signerAddress);

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
  isString(value.signedMessage) &&
  isString(value.signerAddress);

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
  isString(value.address);

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
  isRecord(value) && value.funded === true && isString(value.address);

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
  if (!isRecord(value) || !isString(value.asset) || !isString(value.balance)) {
    return false;
  }
  if (value.type === 'soroban') {
    return isString(value.contractId);
  }
  return (
    (value.type === 'native' || value.type === 'classic') &&
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
  isString(value.address) &&
  typeof value.funded === 'boolean' &&
  (value.sequence === null || isString(value.sequence)) &&
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
  isString(value.symbol) &&
  typeof value.decimals === 'number' &&
  Number.isInteger(value.decimals);
