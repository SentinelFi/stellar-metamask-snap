import { describe, expect, it } from '@jest/globals';
import { Asset, LiquidityPoolAsset, Memo } from '@stellar/stellar-sdk';

import {
  bytesToDisplay,
  containsHiddenCharacters,
  displayOrigin,
  escapeHiddenCharacters,
  formatAsset,
  formatLiquidityPool,
  formatMemo,
  formatTokenAsset,
  isHexDisplay,
  isLossyInline,
  isOriginDisplayLossy,
  originLooksConfusable,
  sanitizeInlineText,
  stroopsToXlm,
  truncate,
} from './format';

const ISSUER = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

describe('truncate', () => {
  it('leaves short strings unchanged', () => {
    expect(truncate('GABC')).toBe('GABC');
    expect(truncate('1234567890123')).toBe('1234567890123'); // exactly 6*2+1
  });

  it('truncates long strings with an ellipsis, keeping both ends', () => {
    expect(truncate('GDRXE2BQUC3AZNPVFSCEZ')).toBe('GDRXE2…VFSCEZ');
  });

  it('honors a custom keep length', () => {
    expect(truncate('ABCDEFGHIJKL', 3)).toBe('ABC…JKL');
  });
});

describe('formatAsset', () => {
  it('renders the native asset as XLM', () => {
    expect(formatAsset(Asset.native())).toBe('XLM');
  });

  it('renders a credit asset as CODE (truncated issuer)', () => {
    expect(formatAsset(new Asset('USDC', ISSUER))).toBe('USDC (GDRXE2…SUJUJ6)');
  });

  it('names the constituents of a liquidity-pool asset', () => {
    // Regression: every pool rendered as the same opaque "Liquidity pool
    // shares" label, so a trustline against one pool was indistinguishable
    // from one against any other.
    const pool = new LiquidityPoolAsset(
      Asset.native(),
      new Asset('USDC', ISSUER),
      30,
    );
    expect(formatAsset(pool)).toBe('Pool shares: XLM / USDC (GDRXE2…SUJUJ6)');
  });
});

describe('formatLiquidityPool', () => {
  it('gives the full identity of the pool a trustline is for', () => {
    const pool = new LiquidityPoolAsset(
      Asset.native(),
      new Asset('USDC', ISSUER),
      30,
    );
    const lines = formatLiquidityPool(pool);

    expect(lines).toStrictEqual([
      'Asset A: XLM (native)',
      `Asset B: USDC:${ISSUER}`,
      'Pool fee: 30 basis points',
      // The pool ID is derived from the constituents and fee, so it is a
      // commitment to exactly the pool being trusted.
      expect.stringMatching(/^Pool ID: [0-9a-f]{64}$/u),
    ]);
  });

  it('returns null for assets that are not pools', () => {
    expect(formatLiquidityPool(Asset.native())).toBeNull();
    expect(formatLiquidityPool(new Asset('USDC', ISSUER))).toBeNull();
    expect(formatLiquidityPool(undefined)).toBeNull();
  });
});

describe('isLossyInline', () => {
  it('flags ordinary tabs and line breaks, not only hidden characters', () => {
    // Regression: the exact-value view was gated on containsHiddenCharacters,
    // which deliberately tolerates \t\n\r, so `one\ntwo` displayed as
    // `one two` with no warning and no exact representation anywhere.
    expect(isLossyInline('one\ntwo')).toBe(true);
    expect(isLossyInline('one\ttwo')).toBe(true);
    expect(isLossyInline('one  two')).toBe(true);
    expect(isLossyInline(' padded ')).toBe(true);
    expect(isLossyInline('one‮two')).toBe(true);
  });

  it('leaves exactly-representable text alone', () => {
    expect(isLossyInline('ordinary text')).toBe(false);
    expect(isLossyInline('')).toBe(false);
    expect(isLossyInline('ünïcödé 🙂')).toBe(false);
  });
});

describe('formatTokenAsset', () => {
  const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  it('pairs the symbol with a truncated contract ID', () => {
    expect(formatTokenAsset('USDC', CONTRACT)).toBe('USDC (CDLZFC…HGCYSC)');
  });

  it('keeps a token calling itself XLM distinguishable from the native row', () => {
    // Regression: the home page used to render the bare contract-reported
    // symbol, letting a hostile token impersonate the native XLM balance.
    const label = formatTokenAsset('XLM', CONTRACT);
    expect(label).not.toBe('XLM');
    expect(label).toContain('CDLZ');
  });
});

describe('stroopsToXlm', () => {
  it('converts whole XLM', () => {
    expect(stroopsToXlm('10000000')).toBe('1');
    expect(stroopsToXlm(0)).toBe('0');
  });

  it('converts fractional amounts and strips trailing zeros', () => {
    expect(stroopsToXlm('15000000')).toBe('1.5');
    expect(stroopsToXlm('12345670')).toBe('1.234567');
    expect(stroopsToXlm('1')).toBe('0.0000001');
  });

  it('is BigInt-safe for large balances', () => {
    // 1,000,000,000 XLM in stroops — beyond Number.MAX_SAFE_INTEGER.
    expect(stroopsToXlm('10000000000000000')).toBe('1000000000');
  });
});

describe('containsHiddenCharacters', () => {
  it('accepts ordinary text including line breaks and tabs', () => {
    expect(containsHiddenCharacters('hello world')).toBe(false);
    expect(containsHiddenCharacters('line one\nline two\ttabbed\r\n')).toBe(
      false,
    );
    expect(containsHiddenCharacters('unicode is fine: héllo ✓ 漢字')).toBe(
      false,
    );
  });

  it('flags control and direction-altering characters', () => {
    // U+202E right-to-left override.
    expect(containsHiddenCharacters('pay 1\u202E001 XLM')).toBe(true);
    // U+200B zero-width space.
    expect(containsHiddenCharacters('admin\u200B@site')).toBe(true);
    // U+0007 bell (C0 control).
    expect(containsHiddenCharacters('beep\u0007')).toBe(true);
    // U+00AD soft hyphen (format character).
    expect(containsHiddenCharacters('soft\u00ADhyphen')).toBe(true);
  });

  it('flags line and paragraph separators', () => {
    // Regression: U+2028/U+2029 are Zl/Zp, not Cc/Cf, so a Cc/Cf-only check
    // missed them. They break lines in most renderers, and `signMessage`
    // gates its whole warning on this function, so a SEP-53 message could
    // render as several lines with nothing to say the preview was not exact.
    expect(containsHiddenCharacters('one\u2028two')).toBe(true);
    expect(containsHiddenCharacters('one\u2029two')).toBe(true);
  });

  it('flags invisible fillers that are ordinary letters or symbols', () => {
    // Regression: these render as blank space but sit in Lo/So/Mn, so no
    // \p{C} class reaches them. They are the standard way to pad text out of
    // view or split a word so it reads as two.
    // U+3164 HANGUL FILLER.
    expect(containsHiddenCharacters('admin\u3164istrator')).toBe(true);
    // U+2800 BRAILLE PATTERN BLANK.
    expect(containsHiddenCharacters('pay\u2800\u2800\u28001 XLM')).toBe(true);
    // U+115F HANGUL CHOSEONG FILLER.
    expect(containsHiddenCharacters('a\u115Fb')).toBe(true);
    // U+FFA0 HALFWIDTH HANGUL FILLER.
    expect(containsHiddenCharacters('a\uFFA0b')).toBe(true);
    // U+17B4 KHMER VOWEL INHERENT AQ.
    expect(containsHiddenCharacters('a\u17B4b')).toBe(true);
  });

  it('flags the invisible nonspacing marks that \\p{Cf} does not reach', () => {
    // Regression: variation selectors, the Mongolian free variation
    // selectors, and the combining grapheme joiner are General Category Mn,
    // render as nothing, and were not in the class, so a memo or signed
    // message could carry them past the warning.
    // U+FE0F VARIATION SELECTOR-16.
    expect(containsHiddenCharacters('pay\uFE0F 1')).toBe(true);
    // U+FE00 VARIATION SELECTOR-1.
    expect(containsHiddenCharacters('a\uFE00b')).toBe(true);
    // U+E0100 VARIATION SELECTOR-17 (supplementary plane).
    expect(containsHiddenCharacters('a\u{E0100}b')).toBe(true);
    // U+180B MONGOLIAN FREE VARIATION SELECTOR ONE.
    expect(containsHiddenCharacters('a\u180Bb')).toBe(true);
    // U+034F COMBINING GRAPHEME JOINER.
    expect(containsHiddenCharacters('a\u034Fb')).toBe(true);
    // U+E000, a private-use code point with no standard glyph.
    expect(containsHiddenCharacters('a\uE000b')).toBe(true);
  });

  it('makes every flagged character visible when escaped', () => {
    // Detection and escaping must cover the same set: a character flagged but
    // not escaped leaves the user warned with nothing to inspect.
    for (const char of [
      '\u202E',
      '\u200B',
      '',
      '\uFE0F',
      '\u{E0100}',
      '\u180B',
      '\u034F',
      '\uE000',
      '\u00AD',
      '\u2028',
      '\u2029',
      '\u3164',
      '\u2800',
      '\u115F',
      '\uFFA0',
      '\u17B4',
    ]) {
      const value = `a${char}b`;
      expect(containsHiddenCharacters(value)).toBe(true);
      expect(escapeHiddenCharacters(value)).toBe(
        `a\\u{${(char.codePointAt(0) as number).toString(16)}}b`,
      );
      // And inline rendering must report itself as lossy for the same set.
      expect(isLossyInline(value)).toBe(true);
    }
  });
});

describe('sanitizeInlineText', () => {
  it('leaves ordinary text unchanged', () => {
    expect(sanitizeInlineText('transfer')).toBe('transfer');
    expect(sanitizeInlineText('héllo 漢字 ✓')).toBe('héllo 漢字 ✓');
  });

  it('strips newlines so a memo cannot forge extra dialog lines', () => {
    expect(sanitizeInlineText('sign data\n\n**Spoofed field**: x')).toBe(
      'sign data **Spoofed field**: x',
    );
  });

  it('replaces control, format, and bidi characters with a space', () => {
    expect(sanitizeInlineText('pay 1\u202E001')).toBe('pay 1 001');
    expect(sanitizeInlineText('a\u200Bb')).toBe('a b');
    expect(sanitizeInlineText('beep\u0007')).toBe('beep');
    expect(sanitizeInlineText('soft\u00ADhyphen')).toBe('soft hyphen');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(sanitizeInlineText('  a\t\t b  ')).toBe('a b');
  });
});

describe('formatMemo', () => {
  it('renders each memo type', () => {
    expect(formatMemo(Memo.text('hello'))).toStrictEqual([
      'Memo (text)',
      'hello',
    ]);
    expect(formatMemo(Memo.id('42'))).toStrictEqual(['Memo (ID)', '42']);

    const hash = Buffer.alloc(32, 1);
    expect(formatMemo(Memo.hash(hash))).toStrictEqual([
      'Memo (hash)',
      hash.toString('hex'),
    ]);
    expect(formatMemo(Memo.return(hash))).toStrictEqual([
      'Memo (return)',
      hash.toString('hex'),
    ]);
  });

  it('returns null for an empty memo', () => {
    expect(formatMemo(Memo.none())).toBeNull();
  });

  it('sanitizes dapp-controlled text memos', () => {
    expect(formatMemo(Memo.text('a\nb'))).toStrictEqual(['Memo (text)', 'a b']);
  });
});

describe('escapeHiddenCharacters', () => {
  it('makes bidi overrides visible as unicode escapes', () => {
    expect(escapeHiddenCharacters('a\u202Eb')).toBe('a\\u{202e}b');
  });

  it('escapes control and zero-width characters', () => {
    expect(escapeHiddenCharacters('a\u0000\u200bb')).toBe('a\\u{0}\\u{200b}b');
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeHiddenCharacters('hello world')).toBe('hello world');
  });

  it('escapes literal backslashes so the encoding is unambiguous', () => {
    // Regression: without backslash escaping, a value containing the plain
    // ASCII text `\u{202e}` rendered identically to a value containing the
    // actual U+202E override character.
    const bidi = String.fromCodePoint(0x202e);
    expect(escapeHiddenCharacters('a\\u{202e}b')).toBe('a\\\\u{202e}b');
    expect(escapeHiddenCharacters(`a${bidi}b`)).toBe('a\\u{202e}b');
    expect(escapeHiddenCharacters('a\\u{202e}b')).not.toBe(
      escapeHiddenCharacters(`a${bidi}b`),
    );
  });
});

describe('displayOrigin', () => {
  it('leaves ordinary origins unchanged', () => {
    expect(displayOrigin('https://example.com')).toBe('https://example.com');
  });

  it('strips control characters', () => {
    expect(displayOrigin('https://ex\u202Eample.com')).toBe(
      'https://ex ample.com',
    );
  });

  it('middle-truncates very long origins', () => {
    const long = `https://${'a'.repeat(100)}.example.com`;
    const shown = displayOrigin(long);
    expect(shown.length).toBeLessThan(long.length);
    expect(shown).toContain('…');
  });
});

describe('isOriginDisplayLossy', () => {
  it('is false when the inline display is the complete origin', () => {
    expect(isOriginDisplayLossy('https://example.com')).toBe(false);
  });

  it('is true when middle truncation would hide part of the origin', () => {
    // Two long origins sharing a prefix and suffix display identically once
    // truncated; the caller must show the complete origin alongside.
    const prefix = `https://${'a'.repeat(40)}`;
    const suffix = `${'b'.repeat(40)}.example.com`;
    const first = `${prefix}-one-${suffix}`;
    const second = `${prefix}-two-${suffix}`;
    expect(isOriginDisplayLossy(first)).toBe(true);
    expect(displayOrigin(first)).toBe(displayOrigin(second));
  });

  it('is true when sanitization altered the origin', () => {
    expect(isOriginDisplayLossy('https://ex‮ample.com')).toBe(true);
  });
});

describe('originLooksConfusable', () => {
  it('flags punycode labels', () => {
    expect(originLooksConfusable('https://xn--80ak6aa92e.com')).toBe(true);
  });

  it('flags non-ASCII characters', () => {
    expect(originLooksConfusable('https://аpple.com')).toBe(true); // Cyrillic а
  });

  it('accepts ordinary ASCII origins', () => {
    expect(originLooksConfusable('https://example.com')).toBe(false);
  });
});

describe('bytesToDisplay', () => {
  it('renders clean text that merely starts with the hex marker as hex', () => {
    // Without this the literal text `hex:00` and the single byte 0x00 would
    // display identically.
    expect(bytesToDisplay(Buffer.from('hex:00', 'utf8'))).toBe(
      `hex:${Buffer.from('hex:00', 'utf8').toString('hex')}`,
    );
    expect(isHexDisplay(bytesToDisplay(Buffer.from('hex:00', 'utf8')))).toBe(
      true,
    );
    expect(isHexDisplay(bytesToDisplay(Buffer.from('plain', 'utf8')))).toBe(
      false,
    );
  });

  it('renders invalid UTF-8 and hidden characters as hex', () => {
    expect(bytesToDisplay(Buffer.from([0x61, 0xff, 0x62]))).toBe('hex:61ff62');
    expect(bytesToDisplay(Buffer.from('a\u200Bb', 'utf8'))).toBe(
      `hex:${Buffer.from('a\u200Bb', 'utf8').toString('hex')}`,
    );
    expect(bytesToDisplay(Buffer.from('plain', 'utf8'))).toBe('plain');
  });
});
