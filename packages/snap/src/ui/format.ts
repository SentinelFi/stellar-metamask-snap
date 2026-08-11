import type { Memo } from '@stellar/stellar-sdk';
import { Asset } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

/**
 * Truncates a long identifier for display: `GDRXE2…OHSUJ6`.
 *
 * @param value - The string to truncate.
 * @param keep - Characters to keep on each side.
 * @returns The truncated string.
 */
export function truncate(value: string, keep = 6): string {
  if (value.length <= keep * 2 + 1) {
    return value;
  }
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/**
 * Human-readable asset name: `XLM` or `CODE (ISSU…UER)`.
 *
 * @param asset - A stellar-sdk Asset (or liquidity-pool asset).
 * @returns Display string.
 */
export function formatAsset(asset: unknown): string {
  if (asset instanceof Asset) {
    return asset.isNative()
      ? 'XLM'
      : `${asset.getCode()} (${truncate(asset.getIssuer() ?? '', 4)})`;
  }
  return 'Liquidity pool shares';
}

/**
 * Display label for a tracked Soroban token: symbol plus truncated contract
 * ID (`SYM (CDLZ…CYSC)`). The symbol is contract-reported and untrusted, so
 * it is never shown bare — a token calling itself `XLM` must remain
 * distinguishable from the native balance row.
 *
 * @param symbol - The token's contract-reported symbol.
 * @param contractId - The token's contract address.
 * @returns The display label.
 */
export function formatTokenAsset(symbol: string, contractId: string): string {
  return `${symbol} (${truncate(contractId, 4)})`;
}

/**
 * Converts a stroop count to a decimal XLM string (BigInt-safe).
 *
 * @param stroops - Amount in stroops (1 XLM = 10,000,000 stroops).
 * @returns Decimal XLM string.
 */
export function stroopsToXlm(stroops: string | number): string {
  const value = BigInt(stroops);
  const whole = value / 10000000n;
  const fraction = (value % 10000000n)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * Whether a string contains hidden or direction-altering characters
 * (controls, bidi overrides, zero-width marks) that could make the rendered
 * text differ from what is actually signed. Ordinary line breaks and tabs
 * are allowed.
 *
 * @param value - The string to inspect.
 * @returns True when hidden characters are present.
 */
export function containsHiddenCharacters(value: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(value.replace(/[\t\n\r]/gu, ''));
}

/**
 * Sanitizes a dapp-controlled string for inline display in a dialog `Text`
 * or `Row`. Control, format, and direction-altering characters (newlines,
 * bidi overrides, zero-width marks) are replaced with a space and runs of
 * whitespace collapsed, so an attacker cannot forge extra dialog lines or
 * fake fields. Free-form fields that
 * must survive verbatim (e.g. the signed message) belong in `Copyable`,
 * which ignores markup, rather than here.
 *
 * @param value - The untrusted string to display.
 * @returns The display-safe string.
 */
export function sanitizeInlineText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Renders a memo for display.
 *
 * @param memo - The transaction memo.
 * @returns `[label, value]`, or null when the memo is empty.
 */
export function formatMemo(memo: Memo): [string, string] | null {
  switch (memo.type) {
    case 'text':
      return ['Memo (text)', sanitizeInlineText(memo.value?.toString() ?? '')];
    case 'id':
      return ['Memo (ID)', String(memo.value)];
    case 'hash':
      return ['Memo (hash)', Buffer.from(memo.value as Buffer).toString('hex')];
    case 'return':
      return [
        'Memo (return)',
        Buffer.from(memo.value as Buffer).toString('hex'),
      ];
    case 'none':
    default:
      return null;
  }
}
