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
 * Renders a memo for display.
 *
 * @param memo - The transaction memo.
 * @returns `[label, value]`, or null when the memo is empty.
 */
export function formatMemo(memo: Memo): [string, string] | null {
  switch (memo.type) {
    case 'text':
      return ['Memo (text)', memo.value?.toString() ?? ''];
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
