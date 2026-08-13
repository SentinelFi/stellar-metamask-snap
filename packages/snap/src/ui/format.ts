import type { Memo } from '@stellar/stellar-sdk';
import {
  Asset,
  getLiquidityPoolId,
  LiquidityPoolAsset,
} from '@stellar/stellar-sdk';
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
  if (asset instanceof LiquidityPoolAsset) {
    // Name the pool's constituents inline. "Liquidity pool shares" alone
    // cannot tell one pool from another, so it does not identify what a
    // trustline is actually being opened against.
    return `Pool shares: ${formatAsset(asset.assetA)} / ${formatAsset(
      asset.assetB,
    )}`;
  }
  return 'Liquidity pool shares';
}

/**
 * Full identity of a liquidity-pool asset: both constituent assets with
 * complete issuers, the pool fee, and the pool ID the trustline is for.
 *
 * @param asset - A stellar-sdk asset.
 * @returns Display lines, or null when the asset is not a pool asset or its
 * identity cannot be computed.
 */
export function formatLiquidityPool(asset: unknown): string[] | null {
  if (!(asset instanceof LiquidityPoolAsset)) {
    return null;
  }
  const lines = [
    `Asset A: ${asset.assetA.isNative() ? 'XLM (native)' : asset.assetA.toString()}`,
    `Asset B: ${asset.assetB.isNative() ? 'XLM (native)' : asset.assetB.toString()}`,
    `Pool fee: ${asset.fee} basis points`,
  ];
  try {
    const poolId = getLiquidityPoolId(
      'constant_product',
      asset.getLiquidityPoolParameters(),
    ).toString('hex');
    lines.push(`Pool ID: ${poolId}`);
  } catch {
    // Without the pool ID the constituents still identify the pool; the
    // caller decides whether that is enough to display.
    return null;
  }
  return lines;
}

/**
 * Full, lossless asset identity for copy/inspection: `XLM (native)` or
 * `CODE:GFULLISSUER…`. Complements {@link formatAsset}, which shortens the
 * issuer for inline rows.
 *
 * @param asset - A stellar-sdk Asset (or liquidity-pool asset).
 * @returns The full identity string, or null when there is nothing beyond
 * the inline form (native asset or pool shares).
 */
export function formatAssetFull(asset: unknown): string | null {
  if (asset instanceof Asset && !asset.isNative()) {
    return `${asset.getCode()}:${asset.getIssuer()}`;
  }
  return null;
}

/**
 * Renders untrusted bytes losslessly: UTF-8 text when the bytes are clean,
 * printable UTF-8 (round-trips exactly and carries no hidden characters),
 * otherwise the full hex form prefixed `hex:`. Intended for `Copyable`, so
 * nothing is truncated.
 *
 * @param bytes - The raw bytes.
 * @returns The display string.
 */
export function bytesToDisplay(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString('utf8');
  const roundTrips = Buffer.from(text, 'utf8').equals(buffer);
  if (roundTrips && !containsHiddenCharacters(text)) {
    return text;
  }
  return `hex:${buffer.toString('hex')}`;
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
 * Escapes hidden or direction-altering characters (controls, bidi overrides,
 * zero-width marks) as visible `\u{...}` escapes, so text that must be shown
 * near-verbatim (ScVal strings, symbols) cannot reorder or hide parts of the
 * rendered dialog. Unlike {@link sanitizeInlineText} this is lossless: the
 * user can see exactly which code points are present.
 *
 * @param value - The untrusted string.
 * @returns The string with hidden characters made visible.
 */
export function escapeHiddenCharacters(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `\\u{${code.toString(16)}}`;
  });
}

/** Inline display cap for origins, so a long origin cannot flood a dialog. */
const MAX_ORIGIN_DISPLAY_LENGTH = 64;

/**
 * Renders a requesting origin for inline dialog display: control characters
 * stripped and very long origins middle-truncated. Origins are supplied by
 * MetaMask, so this is defense in depth, not a trust boundary.
 *
 * @param origin - The origin string from MetaMask.
 * @returns The display-safe origin.
 */
export function displayOrigin(origin: string): string {
  const clean = sanitizeInlineText(origin);
  return clean.length > MAX_ORIGIN_DISPLAY_LENGTH ? truncate(clean, 30) : clean;
}

/**
 * Whether {@link displayOrigin} loses information for this origin: middle
 * truncation keeps only the prefix and suffix, so two long origins sharing
 * those can display identically. Callers must then show the complete origin
 * alongside the inline form.
 *
 * @param origin - The origin string from MetaMask.
 * @returns True when the inline display is not the complete origin.
 */
export function isOriginDisplayLossy(origin: string): boolean {
  return displayOrigin(origin) !== origin;
}

/**
 * Whether an origin contains internationalized (punycode `xn--`) labels or
 * non-ASCII characters that could visually imitate another site's address.
 *
 * @param origin - The origin string from MetaMask.
 * @returns True when the origin warrants a homoglyph caution.
 */
export function originLooksConfusable(origin: string): boolean {
  return /xn--/iu.test(origin) || /[^ -~]/u.test(origin);
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
 * Whether inline display would lose information about a value.
 *
 * Broader than {@link containsHiddenCharacters}, which deliberately tolerates
 * ordinary tabs and line breaks. Those are not hidden, but
 * {@link sanitizeInlineText} still collapses them, so `one\ntwo` renders as
 * `one two`: a difference between what the user reads and what they sign,
 * with nothing to signal it. This is the condition that decides whether an
 * exact, escaped copy is shown alongside the inline preview.
 *
 * @param value - The untrusted string.
 * @returns True when the inline rendering differs from the value itself.
 */
export function isLossyInline(value: string): boolean {
  return sanitizeInlineText(value) !== value;
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
