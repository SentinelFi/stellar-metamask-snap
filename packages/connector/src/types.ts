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

/** Typed error thrown by the connector; `code` follows SEP-0043. */
export class StellarSnapError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = 'StellarSnapError';
    this.code = code;
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

export type SignTransactionOptions = {
  networkPassphrase?: string;
  address?: string;
  /** When true, the snap also submits the signed transaction. */
  submit?: boolean;
};

export type SignTransactionResult = {
  signedTxXdr: string;
  signerAddress: string;
  /** Present when `submit: true` was requested. */
  hash?: string;
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
  address?: string;
};

export type SignMessageResult = {
  /** Base64-encoded ed25519 signature (SEP-53). */
  signedMessage: string;
  signerAddress: string;
};

export type BalanceLine = {
  /** `'XLM'` for the native asset, otherwise `CODE:ISSUER`. */
  asset: string;
  balance: string;
};

export type BalancesResult = {
  address: string;
  funded: boolean;
  sequence: string | null;
  balances: BalanceLine[];
};

export type FundResult = { funded: true; address: string };
