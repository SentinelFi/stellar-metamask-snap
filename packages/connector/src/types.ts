/** Minimal EIP-1193 provider surface the connector needs. */
export type Eip1193Provider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
};

/** SEP-0043 error codes surfaced by the snap in `error.data.code`. */
export const SEP43_ERROR_CODES = {
  internal: -1,
  externalService: -2,
  invalidRequest: -3,
  userRejected: -4,
} as const;

export type Sep43ErrorCode =
  (typeof SEP43_ERROR_CODES)[keyof typeof SEP43_ERROR_CODES];

/**
 * Recovery data the snap attaches when a post-approval submission fails: the
 * signature was produced, so callers can still poll or retry with it.
 */
export type StellarSnapErrorData = {
  /** The signed transaction envelope, present on submit-after-sign failures. */
  signedTxXdr?: string;
  /** The signer address. */
  signerAddress?: string;
  /** The transaction hash when one was assigned before failure. */
  hash?: string;
  /** The Soroban RPC status, when present. */
  status?: string;
};

/** Typed error thrown by the connector; `code` follows SEP-0043. */
export class StellarSnapError extends Error {
  readonly code: number;

  /** Recovery data preserved from the snap's `error.data`, when present. */
  readonly data?: StellarSnapErrorData;

  constructor(message: string, code: number, data?: StellarSnapErrorData) {
    super(message);
    this.name = 'StellarSnapError';
    this.code = code;
    if (data) {
      this.data = data;
    }
  }
}

export type NetworkName = 'PUBLIC' | 'TESTNET' | 'FUTURENET';

export type GetAddressResult = { address: string };

export type NetworkResult = {
  network: NetworkName;
  networkPassphrase: string;
};

export type NetworkDetailsResult = NetworkResult & {
  networkUrl: string;
  sorobanRpcUrl: string;
};

/**
 * SEP-0043 `signTransaction` options. The shape follows the standard so a
 * caller holding a SEP-0043 option bag (a Freighter or Wallets Kit
 * integration, for instance) can pass it through unchanged, and so that any
 * field the wallet does not honour is refused with an explicit message
 * instead of a generic invalid-request error from the snap.
 */
export type SignTransactionOptions = {
  /** Expected network passphrase; checked against the wallet's network. */
  networkPassphrase?: string;
  /** A revealed account to sign with, instead of the active one. */
  address?: string;
  /** When true, the snap also submits the signed transaction. */
  submit?: boolean;
  /**
   * Declared for SEP-0043 shape compatibility only: **not supported**. The
   * snap submits only to its own allowlisted Horizon and Soroban RPC
   * endpoints, never to a dapp-chosen URL, because a caller-supplied
   * submission host could delay, withhold, or front-run a signed envelope.
   * Passing any value here is rejected client-side with an
   * `invalidRequest` (`-3`) `StellarSnapError` before the wallet is
   * contacted. It is refused rather than silently dropped so a caller never
   * believes its endpoint was used when it was not.
   */
  submitUrl?: string;
};

export type SignTransactionResult = {
  signedTxXdr: string;
  signerAddress: string;
  /** Present when `submit: true` was requested. */
  hash?: string;
  /** Soroban RPC acceptance status when submitted (PENDING/DUPLICATE). */
  status?: string;
};

export type SignAuthEntryOptions = {
  networkPassphrase?: string;
  address?: string;
};

export type SignAuthEntryResult = {
  signedAuthEntry: string;
  signerAddress: string;
};

export type SignMessageOptions = {
  /**
   * Expected network passphrase (SEP-0043 defines it for `signMessage` as
   * well as for the transaction methods). When present it is compared
   * against the wallet's active network exactly as `signTransaction` does,
   * and a mismatch is rejected with `-3`. Optional: a SEP-0053 message
   * signature itself carries no network, so omitting it is valid.
   */
  networkPassphrase?: string;
  /** A revealed account to sign with, instead of the active one. */
  address?: string;
};

export type SignMessageResult = {
  /** Base64-encoded ed25519 signature (SEP-53). */
  signedMessage: string;
  signerAddress: string;
};

/**
 * What kind of asset a balance row describes.
 *
 * Branch on this rather than parsing {@link BalanceLine.asset}. Classic assets
 * render as `CODE:ISSUER` and tracked Soroban tokens as `SYMBOL:CONTRACT_ID`,
 * so the two are the same shape. A token's symbol is reported by the contract
 * and chosen by whoever wrote it, which means a contract the user was
 * persuaded to track can present itself as `USDC` and a caller splitting on
 * `:` will display exactly that. The only difference in the string is the
 * leading character of the second field.
 */
export type BalanceKind = 'native' | 'classic' | 'soroban';

export type BalanceLine = {
  /**
   * `'XLM'` for the native asset, `CODE:ISSUER` for a classic asset, and
   * `SYMBOL:CONTRACT_ID` for a tracked Soroban token. This is a display
   * string, not an identity: use {@link BalanceLine.type} to tell the cases
   * apart and {@link BalanceLine.contractId} to identify a token.
   */
  asset: string;
  balance: string;
  /** Which kind of asset this row describes. */
  type: BalanceKind;
  /** The token contract, present only when `type` is `'soroban'`. */
  contractId?: string;
};

export type BalancesResult = {
  address: string;
  funded: boolean;
  sequence: string | null;
  balances: BalanceLine[];
  /**
   * Present (and always `true`) when the wallet skipped reading tracked
   * Soroban token balances because its global token-read budget was
   * exhausted.
   *
   * Treat it as "token rows are missing", never as "this account holds none
   * of the tracked tokens": a caller that renders a total, or that decides a
   * token is absent, must account for the difference or retry shortly.
   */
  tokensUnavailable?: true;
  /**
   * Present (and always `true`) when the account holds more classic balances
   * than the wallet's display cap and the list was cut. An asset missing
   * from a truncated list is not necessarily absent from the account.
   */
  balancesTruncated?: true;
};

export type FundResult = { funded: true; address: string };

export type AddTokenResult = {
  contractId: string;
  symbol: string;
  decimals: number;
};

export type SignTransactionResultWithWarnings = SignTransactionResult & {
  /** Advisory safety warnings the snap surfaced (may be absent). */
  warnings?: string[];
};

/** A wallet account the user has revealed. */
export type AccountInfo = {
  /** The SEP-0005 account index (`x` in `m/44'/148'/x'`). */
  index: number;
  /** The account's `G...` address. */
  address: string;
};

export type GetAccountsResult = {
  /** Every revealed account, in index order. */
  accounts: AccountInfo[];
  /** The active account's index. */
  activeIndex: number;
};

export type SetActiveAccountResult = AccountInfo;
