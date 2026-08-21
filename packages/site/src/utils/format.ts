import type { BalanceLine, NetworkName } from 'stellar-soroban-snap-connector';

/**
 * Shortens a long identifier for display: `GDRXE2…OHSUJ6`.
 *
 * @param value - The full value.
 * @param keep - Characters kept on each side.
 * @returns The shortened value, or the original when it is already short.
 */
export function truncateMiddle(value: string, keep = 6): string {
  if (value.length <= keep * 2 + 1) {
    return value;
  }
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/**
 * Formats a Stellar decimal amount for display, keeping full precision but
 * grouping the integer part. Amounts arrive as decimal strings and are never
 * parsed into a float: seven-decimal values do not survive a round trip
 * through IEEE 754, and a balance that renders as `100.00000001` because of
 * it is a bug report.
 *
 * @param amount - The decimal amount string.
 * @returns The grouped display string.
 */
export function formatAmount(amount: string): string {
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole = '0', fraction] = unsigned.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const trimmed = fraction?.replace(/0+$/u, '') ?? '';
  return `${negative ? '-' : ''}${grouped}${trimmed ? `.${trimmed}` : ''}`;
}

/**
 * The display name of a balance row's asset.
 *
 * Branches on `type` rather than parsing the `asset` string: a classic asset
 * renders as `CODE:ISSUER` and a tracked Soroban token as
 * `SYMBOL:CONTRACT_ID`, so the two are the same shape, and a token's symbol is
 * whatever its contract says it is.
 *
 * @param line - The balance row.
 * @returns The asset code or symbol.
 */
export function assetCode(line: BalanceLine): string {
  if (line.type === 'native') {
    return 'XLM';
  }
  const [code] = line.asset.split(':');
  return code ?? line.asset;
}

/**
 * The issuer (classic) or contract (Soroban) behind a balance row.
 *
 * @param line - The balance row.
 * @returns The issuer/contract, or null for the native asset.
 */
export function assetIssuer(line: BalanceLine): string | null {
  if (line.type === 'native') {
    return null;
  }
  if (line.type === 'soroban') {
    return line.contractId ?? null;
  }
  const separator = line.asset.indexOf(':');
  return separator === -1 ? null : line.asset.slice(separator + 1);
}

/** stellar.expert network segments; Futurenet has no explorer there. */
const EXPLORER_SEGMENT: Record<NetworkName, string | null> = {
  PUBLIC: 'public',
  TESTNET: 'testnet',
  FUTURENET: null,
};

/**
 * A Stellar transaction hash: exactly 32 bytes as hex. Anything else is not
 * a hash and must not be put into a URL path as one.
 */
const TRANSACTION_HASH = /^[0-9a-f]{64}$/iu;

/**
 * Whether a value has the shape of a transaction hash.
 *
 * @param value - The candidate.
 * @returns True for 64 hex characters.
 */
export function isTransactionHash(value: string): boolean {
  return TRANSACTION_HASH.test(value);
}

/**
 * A stellar.expert link for a transaction hash.
 *
 * The hash is interpolated into a URL path, and the values that reach here
 * from the activity table come from Horizon, an endpoint this page does not
 * control. A string that is not a 64-hex hash therefore gets no link at all:
 * the origin is fixed, so the worst case is steering the path or query of
 * the explorer URL, but a link labelled as "this transaction" that opens
 * something else is still a link the user should never be offered. The
 * caller renders the raw value as text in that case.
 *
 * @param network - The active network.
 * @param hash - The transaction hash.
 * @returns The URL, or null when the network has no explorer or the value is
 * not a well-formed hash.
 */
export function explorerTxUrl(
  network: NetworkName,
  hash: string,
): string | null {
  const segment = EXPLORER_SEGMENT[network];
  return segment && isTransactionHash(hash)
    ? `https://stellar.expert/explorer/${segment}/tx/${hash}`
    : null;
}

/** A well-formed `G...` ed25519 account address. */
const ACCOUNT_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/u;

/**
 * A stellar.expert link for an account.
 *
 * The address is validated for the same reason {@link explorerTxUrl}
 * validates its hash: the value crosses a trust boundary (it arrives from
 * the wallet provider, which page scripts can impersonate), and while the
 * link's origin is fixed, a value that is not an account address could steer
 * the path or query of a link labelled as "this account". No link is offered
 * for anything else; the caller renders the raw value as text.
 *
 * @param network - The active network.
 * @param address - The `G...` account.
 * @returns The URL, or null when the network has no explorer or the value is
 * not a well-formed account address.
 */
export function explorerAccountUrl(
  network: NetworkName,
  address: string,
): string | null {
  const segment = EXPLORER_SEGMENT[network];
  return segment && ACCOUNT_ADDRESS_PATTERN.test(address)
    ? `https://stellar.expert/explorer/${segment}/account/${address}`
    : null;
}

/**
 * Renders an ISO timestamp as a short local date and time.
 *
 * @param iso - The ISO 8601 timestamp.
 * @returns The formatted timestamp, or the raw value when unparseable.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
