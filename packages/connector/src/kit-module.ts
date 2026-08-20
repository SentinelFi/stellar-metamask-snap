import type { StellarSnapOptions } from './snap.js';
import { StellarSnap } from './snap.js';

/**
 * The snap's mark as a data URI (Stellar slashed-circle in the snap's
 * gold-on-navy colorway) — the Wallets Kit renders it in its wallet picker.
 */
const PRODUCT_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101d3c"/><stop offset="1" stop-color="#1c1240"/></linearGradient><mask id="cut"><rect x="0" y="0" width="100" height="100" fill="white"/><rect x="4" y="39" width="92" height="22" fill="black" transform="rotate(-30 50 50)"/></mask></defs><circle cx="50" cy="50" r="50" fill="url(#bg)"/><circle cx="50" cy="50" r="24" fill="none" stroke="#f5b32a" stroke-width="5.5" mask="url(#cut)"/><g transform="rotate(-30 50 50)"><rect x="8" y="41.5" width="84" height="5.5" rx="2.75" fill="#f5b32a"/><rect x="8" y="53" width="84" height="5.5" rx="2.75" fill="#f5b32a"/></g></svg>',
)}`;

/**
 * Stellar Wallets Kit module for the Stellar Soroban MetaMask Snap.
 *
 * Structurally implements the kit's `ModuleInterface` (no dependency on the
 * kit package itself). Usage:
 *
 * ```ts
 * import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit';
 * import { StellarSnapKitModule } from 'stellar-soroban-snap-connector';
 *
 * const kit = new StellarWalletsKit({
 *   modules: [...defaultModules(), new StellarSnapKitModule()],
 *   // ...
 * });
 * ```
 */
export class StellarSnapKitModule {
  /** Kit ModuleType.HOT_WALLET. */
  readonly moduleType = 'HOT_WALLET';

  readonly productId = 'metamask-stellar-snap';

  readonly productName = 'MetaMask (Stellar Snap)';

  readonly productUrl = 'https://metamask.io';

  readonly productIcon = PRODUCT_ICON;

  readonly #snap: StellarSnap;

  constructor(options: StellarSnapOptions = {}) {
    this.#snap = new StellarSnap(options);
  }

  /**
   * Whether MetaMask with snaps support is present.
   *
   * @returns True when available.
   */
  async isAvailable(): Promise<boolean> {
    return this.#snap.isAvailable();
  }

  /**
   * Kit `getAddress`: installs/connects on first use, then returns the
   * wallet address.
   *
   * @param params - Kit params (`skipRequestAccess` honored).
   * @param params.skipRequestAccess - When true, never prompts.
   * @returns The wallet address.
   */
  async getAddress(params?: {
    skipRequestAccess?: boolean;
  }): Promise<{ address: string }> {
    if (params?.skipRequestAccess) {
      return this.#snap.getAddress();
    }
    return this.#snap.connect();
  }

  /**
   * Kit `signTransaction`.
   *
   * The option bag is forwarded to the typed client, which applies the same
   * rules as for a direct caller: `submit` is honoured, and `submitUrl` is
   * refused with `-3` before the wallet is contacted, because the snap only
   * submits to its own allowlisted endpoints and a kit user that named
   * another one must not be left believing it was used.
   *
   * @param xdr - Base64 transaction envelope XDR.
   * @param opts - Kit option bag.
   * @param opts.networkPassphrase - Expected network passphrase.
   * @param opts.address - Requested signer address.
   * @param opts.submit - When true, the wallet also submits the signed
   * transaction.
   * @param opts.submitUrl - Not supported; any value is rejected with `-3`.
   * @returns The signed envelope and signer address.
   */
  async signTransaction(
    xdr: string,
    opts?: {
      networkPassphrase?: string;
      address?: string;
      submit?: boolean;
      submitUrl?: string;
    },
  ): Promise<{ signedTxXdr: string; signerAddress?: string }> {
    return this.#snap.signTransaction(xdr, opts ?? {});
  }

  /**
   * Kit `signAuthEntry`.
   *
   * @param authEntry - Base64 SorobanAuthorizationEntry XDR.
   * @param opts - Kit option bag.
   * @param opts.networkPassphrase - Expected network passphrase.
   * @param opts.address - Requested signer address.
   * @returns The signed entry and signer address.
   */
  async signAuthEntry(
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string }> {
    return this.#snap.signAuthEntry(authEntry, opts ?? {});
  }

  /**
   * Kit `signMessage`.
   *
   * @param message - The message to sign.
   * @param opts - Kit option bag.
   * @param opts.networkPassphrase - Expected network passphrase; when
   * present it is checked against the wallet's network.
   * @param opts.address - Requested signer address.
   * @returns The base64 signature and signer address.
   */
  async signMessage(
    message: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedMessage: string; signerAddress?: string }> {
    return this.#snap.signMessage(message, opts ?? {});
  }

  /**
   * Kit `getNetwork`.
   *
   * @returns The active network and passphrase.
   */
  async getNetwork(): Promise<{
    network: string;
    networkPassphrase: string;
  }> {
    return this.#snap.getNetwork();
  }
}
