import { describe, expect, it } from '@jest/globals';
import { Asset, LiquidityPoolAsset, Memo } from '@stellar/stellar-sdk';

import {
  containsHiddenCharacters,
  formatAsset,
  formatMemo,
  formatTokenAsset,
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
    expect(formatAsset(new Asset('USDC', ISSUER))).toBe('USDC (GDRX…JUJ6)');
  });

  it('labels liquidity-pool assets', () => {
    const pool = new LiquidityPoolAsset(
      Asset.native(),
      new Asset('USDC', ISSUER),
      30,
    );
    expect(formatAsset(pool)).toBe('Liquidity pool shares');
  });
});

describe('formatTokenAsset', () => {
  const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  it('pairs the symbol with a truncated contract ID', () => {
    expect(formatTokenAsset('USDC', CONTRACT)).toBe('USDC (CDLZ…CYSC)');
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
