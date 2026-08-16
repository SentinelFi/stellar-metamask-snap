# Connector API reference

`stellar-soroban-snap-connector` is the dapp-facing package: a typed SEP-0043 client over MetaMask's `wallet_invokeSnap`, a drop-in facade for `@stellar/freighter-api`, and a module for [Stellar Wallets Kit](https://stellarwalletskit.dev). A dapp never speaks to the snap directly; it speaks to this.

Three things are worth knowing before the method list, because they explain most of the design.

**The snap version is pinned, not ranged.** `DEFAULT_SNAP_VERSION` is an exact `x.y.z`, and a range is rejected at construction. A range would let an install resolve to a release that was never audited, which is the one thing the pin exists to prevent. `isInstalled()` reports an installed-but-different version as _not installed_, because every call made against it would run code other than the release the pin names.

**Results are validated, not assumed.** Every typed method checks the shape of what comes back across the provider boundary before returning it. The untyped escape hatch, `invoke()`, returns `unknown` on purpose: it has not done that work, and its caller has to.

**Errors carry SEP-0043 codes.** Failures arrive as `StellarSnapError` with a `code` drawn from four known values. Only those four pass through; an arbitrary upstream number cannot impersonate one. Branch on `-4` (`userRejected`) to tell "the user said no, do not retry" from "something broke".

## Installation

```bash
npm install stellar-soroban-snap-connector
```

## Getting started

```ts
import { StellarSnap } from 'stellar-soroban-snap-connector';

const snap = new StellarSnap();

if (!(await snap.isAvailable())) {
  // MetaMask is absent or does not support snaps.
}

// Installs the snap if needed, then asks the user to grant this origin access.
const { address } = await snap.connect();
```

The provider is discovered through EIP-6963 when you do not supply one. Concurrent callers share a single in-flight discovery rather than racing duplicates.

## `new StellarSnap(options?)`

| Option               | Type              | Default                    | Notes                                                                               |
| -------------------- | ----------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `snapId`             | `string`          | `npm:stellar-soroban-snap` | Must be an `npm:` or `local:` ID. Use `local:http://localhost:8080` in development. |
| `version`            | `string`          | the audited release        | Exact `x.y.z` only. Ranges are rejected at construction.                            |
| `provider`           | `Eip1193Provider` | auto-detected              | Supply one to skip EIP-6963 discovery.                                              |
| `discoveryTimeoutMs` | `number`          | provider default           | How long auto-detection waits for announcements.                                    |

Exported alongside it: `DEFAULT_SNAP_ID` and `DEFAULT_SNAP_VERSION`, so a dapp can display or verify what it is about to install.

## Connection and lifecycle

### `getProvider(): Promise<Eip1193Provider>`

Resolves the provider, detecting MetaMask when none was supplied.

### `isAvailable(): Promise<boolean>`

Whether MetaMask is present and supports snaps. Ask this before offering the wallet in a picker.

### `isInstalled(): Promise<boolean>`

Whether this snap is installed **at the pinned version**. For `npm:` IDs a version mismatch reads as not installed. Local development snaps carry no meaningful version and only need to be present.

### `connect(): Promise<{ address: string }>`

Installs or reconnects the snap, then requests wallet access. The `wallet_requestSnaps` result is verified rather than assumed: MetaMask may keep an already-installed copy instead of installing the requested version, and a mismatch fails here, before any signing surface is touched.

### `invoke(method: string, params?: object): Promise<unknown>`

The escape hatch for methods with no typed wrapper. Returns `unknown`: the response crossed the provider boundary and nothing has checked its shape.

## Access and identity

### `requestAccess(): Promise<{ address: string }>`

SEP-0043 `requestAccess`. The first call shows a consent dialog; later calls with a standing grant return silently.

### `getAddress(): Promise<{ address: string }>`

A silent read with Freighter semantics: **an empty string until access is granted**, not an error. Treat `''` as "not connected", never as an address.

### `getAccounts(): Promise<{ accounts: AccountInfo[]; activeIndex: number }>`

Every SEP-0005 account the user has revealed, with the active index. Requires a grant. Accounts are added from the snap's own home page, never by a dapp.

### `setActiveAccount(index: number): Promise<AccountInfo>`

Switches the wallet's active account. Requires a grant, and the index must already be revealed.

## Network

### `getNetwork(): Promise<{ network: NetworkName; networkPassphrase: string }>`

### `getNetworkDetails(): Promise<NetworkDetailsResult>`

Adds `networkUrl` (Horizon) and `sorobanRpcUrl` to the above. These are the endpoints the wallet itself uses; a dapp reading the ledger directly should read from the same ones, or it may show a user state from a network their wallet is not on.

### `setNetwork(network: NetworkName): Promise<NetworkDetailsResult>`

Switches the wallet-global network, dialog-confirmed. `NetworkName` is `'PUBLIC' | 'TESTNET' | 'FUTURENET'`.

## Signing

Each method takes an optional `address` to select a revealed account other than the active one, and the transaction methods take an optional `networkPassphrase` that is checked against the wallet's active network.

### `signTransaction(xdr: string, options?): Promise<SignTransactionResultWithWarnings>`

```ts
type SignTransactionOptions = {
  networkPassphrase?: string;
  address?: string;
  /** When true, the wallet also submits the signed transaction. */
  submit?: boolean;
};

type SignTransactionResultWithWarnings = {
  signedTxXdr: string;
  signerAddress: string;
  hash?: string; // present when submitted
  status?: string; // Soroban RPC acceptance status
  warnings?: string[];
};
```

The wallet decodes the review dialog from the XDR you pass, not from anything the dapp says about it. `warnings` carries the advisory safety checks the wallet surfaced (unfunded destination, memo-required, multisig weight); they are shown in its dialog too, but a dapp that repeats them helps a user who has already dismissed it.

With `submit: true` the wallet broadcasts and verifies the returned hash against the envelope it signed. If submission fails _after_ signing, the thrown `StellarSnapError` carries `data.signedTxXdr` so you can retry or poll yourself: the signature exists, and losing it would be the worse failure.

### `signAuthEntry(authEntry: string, options?): Promise<SignAuthEntryResult>`

Signs a base64 `SorobanAuthorizationEntry`. The wallet bounds the entry's expiration ledger against what the network reports.

### `signMessage(message: string, options?): Promise<SignMessageResult>`

SEP-0053 message signing. Returns a base64 ed25519 signature over the prefixed message.

## Account data

### `getBalances(address?): Promise<BalancesResult>`

```ts
type BalancesResult = {
  address: string;
  funded: boolean;
  sequence: string | null;
  balances: BalanceLine[];
  tokensUnavailable?: true;
};

type BalanceLine = {
  asset: string; // 'XLM' | 'CODE:ISSUER' | 'SYMBOL:CONTRACT_ID'
  balance: string;
  type: 'native' | 'classic' | 'soroban';
  contractId?: string;
};
```

**Branch on `type`, never on parsing `asset`.** A classic asset renders as `CODE:ISSUER` and a tracked Soroban token as `SYMBOL:CONTRACT_ID`, so the two strings are the same shape, and a token's symbol is chosen by whoever wrote its contract. A contract the user was persuaded to track can call itself `USDC`, and a caller splitting on `:` will display exactly that.

`tokensUnavailable` means the wallet skipped its tracked-token reads because its token-read budget was exhausted. Classic balances are complete either way. Read it as "token rows are missing", never as "this account holds none of them": a total that ignores the difference is wrong, and so is a UI that concludes a token is absent.

### `addToken(contractId: string): Promise<AddTokenResult>`

Starts tracking a Soroban token (SAC or SEP-0041) so its balance appears in `getBalances`. The wallet reads the contract's own `symbol` and `decimals` by simulation and confirms with the user; nothing about the token is taken on the dapp's word.

### `fund(address?): Promise<FundResult>`

Funds the account from friendbot. Test networks only, and only the wallet's own accounts.

## Errors

```ts
class StellarSnapError extends Error {
  code: number; // SEP-0043
  data?: {
    signedTxXdr?: string; // present on submit-after-sign failures
    signerAddress?: string;
    hash?: string;
    status?: string;
  };
}
```

| Code | Name              | Meaning                                                                    |
| ---- | ----------------- | -------------------------------------------------------------------------- |
| `-1` | `internal`        | The wallet failed in a way it will not describe further.                   |
| `-2` | `externalService` | Horizon or the Soroban RPC could not be reached or answered badly.         |
| `-3` | `invalidRequest`  | The request was malformed, or the wallet refuses to display it faithfully. |
| `-4` | `userRejected`    | The user declined a dialog. Do not retry automatically.                    |

MetaMask's own EIP-1193 connect rejection (`4001`) is normalized to `-4`, so one branch covers both.

`SEP43_ERROR_CODES` is exported for comparison rather than hardcoding numbers.

## Freighter compatibility

### `createFreighterApi(options?)`

Returns an object matching the `@stellar/freighter-api` surface, so an existing Freighter integration can be pointed at the snap without rewriting call sites. Freighter's convention of returning `{ error }` objects rather than throwing is preserved, with `FreighterApiError` carrying the code.

### `WatchWalletChanges`

Polls for address and network changes, mirroring Freighter's helper of the same name.

## Stellar Wallets Kit

### `StellarSnapKitModule`

A kit module, structurally implementing the kit's `ModuleInterface` without depending on the kit package.

```ts
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit';
import { StellarSnapKitModule } from 'stellar-soroban-snap-connector';

const kit = new StellarWalletsKit({
  modules: [...defaultModules(), new StellarSnapKitModule()],
  // ...
});
```

The snap then appears in the kit's wallet picker as **MetaMask (Stellar Snap)**, and every dapp already built on the kit gains MetaMask support without further work.

---

This page is maintained by hand alongside `packages/connector/src`. The docs build fails if a public method exists on `StellarSnap` that this page never mentions, so the method list cannot silently fall behind the code.
