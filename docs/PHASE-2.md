# Phase 2 — Soroban Depth: Implementation Notes

> Built 2026-08-10. Plan reference: [PLAN.md](PLAN.md) Phase 2. Predecessors: [PHASE-0.md](PHASE-0.md), [PHASE-1.md](PHASE-1.md).
> Status: **core complete** — Soroban transaction review with in-snap simulation, `signAuthEntry`, Stellar RPC client; 25/25 tests green, lint clean, SES eval passing. Token balances and multisig awareness deferred (below).

## What shipped

### `signTransaction` understands Soroban transactions

When the (single-operation) transaction is Soroban — `invokeHostFunction`, `extendFootprintTtl`, or `restoreFootprint` — the review dialog now shows:

- **Decoded invocation** (offline, from the XDR): contract `C...` address (copyable), function name, arguments rendered via `scValToNative` (BigInt-safe), authorization count. Wasm uploads / contract creation get an explicit warning banner instead of decode.
- **Display-verification simulation** (Sui-snap pattern) via the active network's Soroban RPC: estimated resource fee (stroops → XLM), the addresses that must sign address-credential auth entries, and a **"Restore required" warning** when the call touches archived ledger entries (`restorePreamble`).
- Simulation is bounded (10s timeout) and **never blocks review**: failure/unreachability renders a "Simulation unavailable" warning with the reason — the user can still decide from the decoded operation + raw XDR.
- **The snap never modifies the transaction it signs.** Simulation is for display only; dapps are expected to submit simulation-assembled envelopes (`prepareTransaction`). The dialog's "Max fee" is the envelope's own bid; "Estimated resource fee" is our independent check.
- `submit: true` for Soroban transactions routes through RPC `sendTransaction` (classic ones keep Horizon's synchronous endpoint); returns the hash without long polling.

### `signAuthEntry` (SEP-43) — the method Soroban dapps require

- Input: base64 `SorobanAuthorizationEntry` XDR (+ optional `networkPassphrase`, `address`).
- Guards (all SEP-43 `-3`): parseable XDR; **address credentials only** (source-account entries are authorized by the envelope signature — signing them separately is a dapp bug); the entry's address must equal the wallet address.
- Dialog renders the **flattened invocation tree** (`contract.function(args)` with indented sub-invocations), replay nonce, and the signature expiration ledger (~5s/ledger note), plus the network banner (mainnet warning on PUBLIC).
- Signing uses the SDK's `authorizeEntry` (audited path): builds `HashIdPreimage(sorobanAuthorization){networkId, nonce, invocation, signatureExpirationLedger}`, signs SHA-256 of it, embeds the `{public_key, signature}` ScVal. **The dapp's expiration ledger is preserved**; when it is 0/unset, defaults to `getLatestLedger + 60` (~5 minutes).
- Returns `{ signedAuthEntry, signerAddress }`; approval also grants the origin (consistent with the Phase 1 consent model).

### Snap home page (Phase 1.5 pulled forward)

`endowment:page-home` + `onHomePage` ([handlers/home.tsx](../packages/snap/src/handlers/home.tsx)): **MetaMask menu → Snaps → Stellar Soroban** now shows the active network, the wallet address (copyable), and live Horizon balances — with graceful degradation ("not funded yet" for off-ledger accounts, "Balances unavailable" when Horizon is unreachable). This is the only in-MetaMask surface available to a non-EVM snap (the Keyring API being closed), and it is an open permission — no allowlist requirement added.

### Infrastructure

- [stellar/rpc.ts](../packages/snap/src/stellar/rpc.ts) — hand-rolled JSON-RPC 2.0 client over `fetch` (`simulateTransaction`, `sendTransaction`, `getTransaction`, `getLatestLedger`) — the SDK's `rpc.Server` transport machinery stays out of the bundle. All failures → SEP-43 `-2`.
- [stellar/soroban.ts](../packages/snap/src/stellar/soroban.ts) — decode helpers: Soroban-op detection, host-function decode, ScVal formatting, auth-entry decode with invocation-tree flattening, `simulateForDisplay` (never throws).
- Bundle: 545 KB (+10 KB over Phase 1) — the XDR/ScVal machinery was already tree-shaken in.

## Testing (25 tests total; 6 new in [soroban.test.tsx](../packages/snap/src/soroban.test.tsx))

- Soroban `signTransaction`: decoded invocation content (contract address, function, `Contract invocation` section) asserted offline; a Simulation section is asserted present in **both** outcomes (live testnet success or the unavailability warning) so the test is network-tolerant but never allows a silently missing section.
- `signAuthEntry` happy path is **fully offline and cryptographically verified**: the test rebuilds the `HashIdPreimage` from the returned entry and verifies the embedded ed25519 signature against the SEP-5 public key; also asserts the dapp's expiration ledger (500000) is preserved.
- Rejection paths: source-account credentials, wrong account, malformed XDR (all `-3`), user rejection (`-4` with Freighter's message).
- The signing dialog asserts invocation, nonce, and expiration content.

## Companion dapp

New **"Sign Soroban invoke"** card: builds a 1 XLM self-`transfer` invocation against the **deterministic XLM Stellar Asset Contract** for the active network (`Asset.native().contractId(passphrase)`) with the live account sequence — so the in-snap simulation genuinely succeeds against testnet and the dialog shows a real resource fee and auth requirements. (The demo envelope is not simulation-assembled, so it is for signing review, not submission.)

## Deferred from the Phase 2 plan (tracked in [PLAN.md](PLAN.md))

- **Token balances + `addToken`** (SAC/custom token metadata via simulated `name()`/`symbol()`/`decimals()`/`balance()` calls, per-network token registry in state): deferred — it is companion-dapp/home-page sugar rather than dapp-compatibility surface, and belongs with the Phase 4 home-page work where balances get displayed.
- **Multisig awareness** (detect insufficient signature weight and label the result "pass to co-signers"): deferred — needs account signer/threshold fetching and careful per-op source handling; scheduled with Phase 4 polish.
- **Restore-then-retry flow** (offering to submit a `restoreFootprint` transaction before the real one): the dialog warns loudly on `restorePreamble` today; the guided flow needs its own consent UX.

## Manual test drive

`yarn start`, then in the Flask profile: Reconnect (pull the new bundle) → Request access → **Sign Soroban invoke** → the MetaMask dialog should show "Operation 1: Contract invocation" with the SAC `C...` address, `transfer`, the three decoded args, and a **Simulation** section with an estimated resource fee (on testnet with a funded account).
