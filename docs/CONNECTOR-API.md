# Connector API reference

`stellar-soroban-snap-connector` is the dapp-facing package: a typed SEP-0043 client over MetaMask's `wallet_invokeSnap`, a drop-in facade for `@stellar/freighter-api`, and a module for [Stellar Wallets Kit](https://stellarwalletskit.dev). A dapp never speaks to the snap directly; it speaks to this.

Three things are worth knowing before the method list, because they explain most of the design.

**The snap version is pinned, not ranged.** `DEFAULT_SNAP_VERSION` is an exact `x.y.z` (no range, no prerelease suffix), and anything else is rejected at construction. A range would let an install resolve to a release that was never audited, which is the one thing the pin exists to prevent. `isInstalled()` reports an installed-but-different version as _not installed_, because every call made against it would run code other than the release the pin names. And the pin is enforced on every call, not only on `connect()`: the first invocation on an `npm:` client reads what MetaMask has installed under the snap ID, refuses a mismatch with `-3` before the snap is contacted, and remembers a match so later calls cost nothing extra. A dapp that reads `getAddress()` first and connects only when it is empty, or that reaches the wallet through the Freighter facade or the Wallets Kit module without ever calling `connect()`, therefore gets the same guarantee.

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

| Option               | Type              | Default                    | Notes                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapId`             | `string`          | `npm:stellar-soroban-snap` | Must be an `npm:` or `local:` ID. Use `local:http://localhost:8080` in development. An `npm:` ID other than the published one is accepted (a fork under test is a legitimate target) but logs a console warning, because the pin and the guarantees on this page describe the published snap. |
| `version`            | `string`          | the audited release        | Exact `x.y.z` only. Ranges and prerelease suffixes are rejected at construction.                                                                                                                                                                                                              |
| `provider`           | `Eip1193Provider` | auto-detected              | Supply one to skip EIP-6963 discovery.                                                                                                                                                                                                                                                        |
| `discoveryTimeoutMs` | `number`          | provider default           | How long auto-detection waits for announcements.                                                                                                                                                                                                                                              |

Exported alongside it: `DEFAULT_SNAP_ID` and `DEFAULT_SNAP_VERSION`, so a dapp can display or verify what it is about to install.

## Connection and lifecycle

### `getProvider(): Promise<Eip1193Provider>`

Resolves the provider, detecting MetaMask when none was supplied.

### `isAvailable(): Promise<boolean>`

Whether MetaMask is present and supports snaps. Ask this before offering the wallet in a picker.

### `isInstalled(): Promise<boolean>`

Whether this snap is installed **at the pinned version**. For `npm:` IDs a version mismatch reads as not installed. Local development snaps carry no meaningful version and only need to be present. A true answer also satisfies the per-call version check for the silent read methods, so asking this first costs one `wallet_getSnaps` read, not two; signing, mutations, `fund`, and raw calls outside the read-only allowlist still perform their own fresh comparison at call time.

### `connect(): Promise<{ address: string }>`

Installs or reconnects the snap, then requests wallet access. The `wallet_requestSnaps` result is verified rather than assumed: MetaMask may keep an already-installed copy instead of installing the requested version, and a mismatch fails here, before any signing surface is touched. This is also the call that repairs a mismatch reported by any other method: it asks MetaMask for the pinned version, which prompts the user to update.

### `invoke(method: string, params?: object): Promise<unknown>`

The escape hatch for methods with no typed wrapper. Returns `unknown`: the response crossed the provider boundary and nothing has checked its shape. It shares the version check with the typed methods, so even the raw path cannot quietly talk to a release other than the pinned one. The method name is arbitrary here, so only the read-only allowlist (`getAddress`, `getNetwork`, `getNetworkDetails`, `getAccounts`, `getBalances`) may answer from the per-page memo; any other name, signing methods included, is compared against a fresh `wallet_getSnaps` read begun after the call was made.

### Version mismatch

Every method that contacts the snap (the typed ones, `invoke()`, and through them the Freighter facade and the Wallets Kit module) throws a `StellarSnapError` with code `-3` when MetaMask reports a version of the snap other than the pinned one installed under the snap ID. The message names both versions. For the silent read methods the check runs once per client instance and is remembered; signing, dialog-confirmed mutations, `fund`, and raw calls outside the read-only allowlist re-read `wallet_getSnaps` on every call, and each such call awaits a lookup begun after it was made rather than one already in flight, so a snap updated mid-session fails closed. The check is repeated after any refusal (the user may update the snap between calls), and is skipped for `local:` IDs. A snap that is not installed at all is not a mismatch: MetaMask refuses the invocation itself, exactly as before, so pre-install handling is unchanged.

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

Each method takes an optional `address` to select a revealed account other than the active one, and an optional `networkPassphrase` that, when present, is checked against the wallet's active network and refused with `-3` on a mismatch. On the PUBLIC network the transaction methods require it, so a mainnet signature is never produced without both parties stating the network.

The option bags follow SEP-0043 so a bag built for any conformant wallet can be passed through unchanged. The positional argument (`xdr`, `authEntry`, `message`) always wins: an option bag that happens to carry a key of the same name cannot replace it.

### `signTransaction(xdr: string, options?): Promise<SignTransactionResultWithWarnings>`

```ts
type SignTransactionOptions = {
  networkPassphrase?: string;
  address?: string;
  /** When true, the wallet also submits the signed transaction. */
  submit?: boolean;
  /** Declared for SEP-0043 shape compatibility; NOT supported (see below). */
  submitUrl?: string;
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

**`submitUrl` is not supported.** SEP-0043 lets a dapp name the endpoint a wallet should submit to; this wallet submits only to its own allowlisted Horizon and Soroban RPC endpoints, never to a dapp-chosen URL, because a caller-supplied submission host could delay, withhold, or front-run a signed envelope. The field exists on the type so a SEP-0043 option bag type-checks, but passing any value is refused client-side with `-3` before MetaMask is contacted (the snap itself refuses it with the same code, naming the same policy). It is refused rather than silently dropped so a caller never believes its endpoint was used when it was not. To broadcast through an endpoint of your own, leave `submit` off and submit the returned `signedTxXdr` yourself.

### `signAuthEntry(authEntry: string, options?): Promise<SignAuthEntryResult>`

Signs a base64 `SorobanAuthorizationEntry`. The wallet bounds the entry's expiration ledger against what the network reports.

### `signMessage(message: string, options?): Promise<SignMessageResult>`

```ts
type SignMessageOptions = {
  networkPassphrase?: string;
  address?: string;
};
```

SEP-0053 message signing. Returns a base64 ed25519 signature over the prefixed message. `networkPassphrase` is accepted because SEP-0043 defines it for `signMessage` too, and when present it is compared against the wallet's active network exactly as for a transaction; it is optional, since the signature itself carries no network.

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

Returns an object matching the `@stellar/freighter-api` surface, so an existing Freighter integration can be pointed at the snap without rewriting call sites. Freighter's convention of returning `{ error }` objects rather than throwing is preserved, with `FreighterApiError` carrying the code. The option bags are the same `SignTransactionOptions`, `SignAuthEntryOptions`, and `SignMessageOptions` as above, with the same rules: `submitUrl` is refused with `-3`, and a version mismatch surfaces as `error.code === -3` (so `isAllowed()` answers `false` against a wrong-version install rather than reading from it).

### `WatchWalletChanges`

Polls for address and network changes, mirroring Freighter's helper of the same name.

## Stellar Wallets Kit

### `StellarSnapKitModule`

A kit module, structurally implementing the kit's `ModuleInterface` without depending on the kit package. Its `signTransaction` accepts the kit's `networkPassphrase`, `address`, `submit`, and `submitUrl` options and forwards them to the typed client, so the rules above apply unchanged (`submitUrl` is refused with `-3`); `signMessage` accepts `networkPassphrase` and `address`; and `getAddress({ skipRequestAccess: true })` is subject to the version check like every other call.

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
