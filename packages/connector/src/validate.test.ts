import { describe, expect, it } from '@jest/globals';

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
} from './validate';

const ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

describe('isAddressResult', () => {
  it('accepts { address: string } including the empty string', () => {
    expect(isAddressResult({ address: ADDRESS })).toBe(true);
    expect(isAddressResult({ address: '' })).toBe(true);
  });

  it('rejects non-records and non-string addresses', () => {
    expect(isAddressResult(null)).toBe(false);
    expect(isAddressResult('GABC')).toBe(false);
    expect(isAddressResult([ADDRESS])).toBe(false);
    expect(isAddressResult({ address: 42 })).toBe(false);
    expect(isAddressResult({})).toBe(false);
  });
});

describe('isNetworkResult / isNetworkDetailsResult', () => {
  const network = {
    network: 'TESTNET',
    networkPassphrase: 'Test SDF Network ; September 2015',
  };
  const details = {
    ...network,
    networkUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  };

  it('accepts known networks and rejects unknown ones', () => {
    expect(isNetworkResult(network)).toBe(true);
    expect(isNetworkResult({ ...network, network: 'DEVNET' })).toBe(false);
    expect(isNetworkResult({ network: 'TESTNET' })).toBe(false);
    // Inherited object keys must not resolve to a known network.
    expect(isNetworkResult({ ...network, network: 'constructor' })).toBe(false);
  });

  it('pins the passphrase to the reported network', () => {
    // A spoofed provider labelling one network with another network's
    // passphrase is exactly the mix a validator that accepted any string
    // would wave through; the snap can only ever report the pinned pairs.
    expect(
      isNetworkResult({
        network: 'TESTNET',
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
      }),
    ).toBe(false);
    expect(isNetworkResult({ ...network, networkPassphrase: 'Test SDF' })).toBe(
      false,
    );
  });

  it('requires the URL fields on network details', () => {
    expect(isNetworkDetailsResult(details)).toBe(true);
    expect(isNetworkDetailsResult(network)).toBe(false);
    expect(
      isNetworkDetailsResult({
        ...details,
        sorobanRpcUrl: undefined,
      }),
    ).toBe(false);
  });

  it('pins the endpoint URLs to the reported network', () => {
    // The snap resolves endpoints from a hardcoded table, so any other URL
    // did not come from the pinned release. Accepting one would let a
    // spoofed provider steer a dapp's account reads to an arbitrary host.
    expect(
      isNetworkDetailsResult({ ...details, networkUrl: 'https://h.example' }),
    ).toBe(false);
    expect(
      isNetworkDetailsResult({
        ...details,
        sorobanRpcUrl: 'https://s.example',
      }),
    ).toBe(false);
    expect(
      isNetworkDetailsResult({
        ...details,
        network: 'PUBLIC',
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
      }),
    ).toBe(false);
  });
});

describe('signing results', () => {
  it('validates signTransaction results including optional fields', () => {
    const base = { signedTxXdr: 'AAAA', signerAddress: ADDRESS };
    expect(isSignTransactionResult(base)).toBe(true);
    expect(
      isSignTransactionResult({
        ...base,
        hash: 'abc',
        status: 'PENDING',
        warnings: ['careful'],
      }),
    ).toBe(true);
    expect(isSignTransactionResult({ ...base, warnings: [42] })).toBe(false);
    expect(isSignTransactionResult({ ...base, hash: 42 })).toBe(false);
    expect(isSignTransactionResult({ signedTxXdr: 'AAAA' })).toBe(false);
  });

  it('validates signAuthEntry and signMessage results', () => {
    expect(
      isSignAuthEntryResult({
        signedAuthEntry: 'AAAA',
        signerAddress: ADDRESS,
      }),
    ).toBe(true);
    expect(isSignAuthEntryResult({ signedAuthEntry: 'AAAA' })).toBe(false);
    expect(
      isSignMessageResult({ signedMessage: 'AAAA', signerAddress: ADDRESS }),
    ).toBe(true);
    expect(isSignMessageResult({ signerAddress: ADDRESS })).toBe(false);
  });
});

describe('account results', () => {
  it('validates getAccounts results', () => {
    expect(
      isGetAccountsResult({
        accounts: [{ index: 0, address: ADDRESS }],
        activeIndex: 0,
      }),
    ).toBe(true);
    expect(isGetAccountsResult({ accounts: [], activeIndex: 0 })).toBe(true);
    expect(
      isGetAccountsResult({
        accounts: [{ index: -1, address: ADDRESS }],
        activeIndex: 0,
      }),
    ).toBe(false);
    expect(
      isGetAccountsResult({
        accounts: [{ index: 0.5, address: ADDRESS }],
        activeIndex: 0,
      }),
    ).toBe(false);
    expect(
      isGetAccountsResult({ accounts: [{ index: 0, address: ADDRESS }] }),
    ).toBe(false);
  });

  it('validates setActiveAccount results', () => {
    expect(isSetActiveAccountResult({ index: 1, address: ADDRESS })).toBe(true);
    expect(isSetActiveAccountResult({ index: '1', address: ADDRESS })).toBe(
      false,
    );
  });
});

describe('funding and balances', () => {
  it('requires funded to be literally true on fund results', () => {
    expect(isFundResult({ funded: true, address: ADDRESS })).toBe(true);
    expect(isFundResult({ funded: false, address: ADDRESS })).toBe(false);
    expect(isFundResult({ funded: true })).toBe(false);
  });

  it('validates balances results', () => {
    const base = {
      address: ADDRESS,
      funded: true,
      sequence: '123',
      balances: [{ asset: 'XLM', balance: '10.0000000', type: 'native' }],
    };
    expect(isBalancesResult(base)).toBe(true);
    expect(isBalancesResult({ ...base, sequence: null })).toBe(true);
    expect(isBalancesResult({ ...base, sequence: 123 })).toBe(false);
    expect(isBalancesResult({ ...base, funded: 'yes' })).toBe(false);
    expect(isBalancesResult({ ...base, balances: [{ asset: 'XLM' }] })).toBe(
      false,
    );
  });

  it('requires every balance row to declare its kind', () => {
    // `type` is what tells a classic `CODE:ISSUER` row apart from a Soroban
    // `SYMBOL:CONTRACT_ID` one, where the symbol is chosen by the token
    // contract. Admitting rows without it would let callers keep splitting
    // `asset` on ':' and displaying an attacker-chosen symbol as though it
    // were an issued asset code, which is the confusion the field exists to
    // remove. So a row missing it, or carrying an unknown kind, is refused.
    const row = (balance: Record<string, unknown>) => ({
      address: ADDRESS,
      funded: true,
      sequence: '123',
      balances: [balance],
    });
    expect(isBalancesResult(row({ asset: 'XLM', balance: '1' }))).toBe(false);
    expect(
      isBalancesResult(row({ asset: 'XLM', balance: '1', type: 'lumens' })),
    ).toBe(false);
  });

  it('ties contractId to soroban rows in both directions', () => {
    // A token row without its contract would force the caller back to parsing
    // the display string, and a classic row carrying one would make the
    // discriminator meaningless.
    const row = (balance: Record<string, unknown>) => ({
      address: ADDRESS,
      funded: true,
      sequence: '123',
      balances: [balance],
    });
    expect(
      isBalancesResult(
        row({
          asset: 'USDC:CABC',
          balance: '1',
          type: 'soroban',
          contractId: 'CABC',
        }),
      ),
    ).toBe(true);
    expect(
      isBalancesResult(
        row({ asset: 'USDC:CABC', balance: '1', type: 'soroban' }),
      ),
    ).toBe(false);
    expect(
      isBalancesResult(
        row({
          asset: 'USDC:GABC',
          balance: '1',
          type: 'classic',
          contractId: 'CABC',
        }),
      ),
    ).toBe(false);
  });
});

describe('isAddTokenResult', () => {
  it('validates token metadata', () => {
    const base = { contractId: 'CABC', symbol: 'USDC', decimals: 7 };
    expect(isAddTokenResult(base)).toBe(true);
    expect(isAddTokenResult({ ...base, decimals: 7.5 })).toBe(false);
    expect(isAddTokenResult({ ...base, symbol: 7 })).toBe(false);
    expect(isAddTokenResult({ contractId: 'CABC' })).toBe(false);
  });
});
