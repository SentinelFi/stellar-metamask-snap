# Phase 3 — Connector Package: Implementation Notes

> Built 2026-08-10. Plan reference: [PLAN.md](PLAN.md) Phase 3. Predecessors: [PHASE-0.md](PHASE-0.md), [PHASE-1.md](PHASE-1.md), [PHASE-2.md](PHASE-2.md).
> Status: **complete** — `packages/connector` ships the typed SEP-43 client, a Freighter-compatible facade, and the Stellar Wallets Kit module; the companion dapp now runs entirely on it. 8 connector unit tests + 26 snap tests green, lint clean.

## Why this phase matters

The connector is the adoption lever: Stellar dapps do not integrate wallets one-by-one — they use the **Stellar Wallets Kit** or the **Freighter API** directly. This package makes MetaMask appear through both doors with zero per-dapp work (the NEAR wallet-selector module and Sui wallet-standard adapter proved this pattern drives installs).

## The package — `stellar-soroban-snap-connector`

Zero runtime dependencies (no stellar-sdk — it is a pure protocol wrapper over `wallet_invokeSnap`), ESM + type declarations, built with plain `tsc`.

### Three integration surfaces

1. **`StellarSnap`** ([src/snap.ts](../packages/connector/src/snap.ts)) — the typed core client:

   - EIP-6963 MetaMask discovery with **exact** rdns matching (`io.metamask` / `.flask` / `.mmi` — `includes()`-style matching would be spoofable), `window.ethereum` fallback, `wallet_getSnaps` probe for snaps support.
   - `connect()` (install + requestAccess with version pinning), `isAvailable()`, `isInstalled()`, and the full SEP-43 surface: `requestAccess`, `getAddress`, `getNetwork(Details)`, `setNetwork`, `signTransaction`, `signAuthEntry`, `signMessage`, plus `fund`/`getBalances`.
   - Every failure throws `StellarSnapError { message, code }` with SEP-43 codes; MetaMask's own EIP-1193 `4001` connect rejection is normalized to `-4`.

2. **`createFreighterApi()`** ([src/freighter.ts](../packages/connector/src/freighter.ts)) — a drop-in for `@stellar/freighter-api` consumers: same method names (`isConnected`, `isAllowed`, `setAllowed`, `requestAccess`, `getAddress`, `getNetwork(Details)`, `sign*`), same `{ ...result, error? }` no-throw convention, plus a polling `WatchWalletChanges`.

3. **`StellarSnapKitModule`** ([src/kit-module.ts](../packages/connector/src/kit-module.ts)) — a Stellar Wallets Kit `ModuleInterface` implementation (verified against the kit's current `types/mod.ts`): `moduleType: 'HOT_WALLET'`, product metadata with the snap's icon as a data URI, `isAvailable()` via snaps-support probe, `getAddress` honoring `skipRequestAccess`, and the three signing methods. Implemented **structurally** — no dependency on the kit package — so dapps plug it in as:

   ```ts
   const kit = new StellarWalletsKit({
     modules: [...defaultModules(), new StellarSnapKitModule()],
     ...
   });
   ```

### Testing

8 unit tests over a mock EIP-1193 provider: exact `wallet_invokeSnap` payload shapes, option-bag passthrough, SEP-43 error normalization (`data.code` → `StellarSnapError.code`), `connect()` version pinning, the Freighter facade's `{ error }` folding, and the kit module's metadata + `skipRequestAccess` behavior.

## Companion dapp migration

[packages/site](../packages/site) now consumes the connector as a workspace dependency — raw `wallet_invokeSnap` plumbing (`useInvokeSnap`) is gone from the page; every action goes through typed `StellarSnap` methods, and errors arrive as typed `StellarSnapError`s. This makes the site the connector's first real-bundler consumer (Gatsby/webpack), which caught one operational note: **clean `.cache` after linking a new workspace dependency** (stale webpack module records surface as `exports is not defined`).

## Naming (provisional until npm publish)

`stellar-soroban-snap` (snap) / `stellar-soroban-snap-connector` (this package). `DEFAULT_SNAP_ID = 'npm:stellar-soroban-snap'`; dev flows pass `snapId: 'local:http://localhost:8080'`.

## Deferred / follow-ups (tracked in [PLAN.md](PLAN.md))

- **Upstream Wallets Kit PR** (list the module in `@creit.tech/stellar-wallets-kit` itself so dapps get it without importing our package): worth filing after the snap is published to npm and allowlisted — the kit lists production wallets, and our `DEFAULT_SNAP_ID` must exist on npm first.
- Connector README + npm publish workflow: Phase 5 (publish alongside the snap).
- `WatchWalletChanges` uses polling (as Freighter does); event-driven updates would need snap-to-dapp notifications, which the platform does not offer today.
