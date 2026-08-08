# Implementation Plan — Stellar Soroban MetaMask Snap

> Companion to [MENTAL-MAP.md](MENTAL-MAP.md) (decisions & rationale) and [docs/research/](research/) (knowledge base).
> Status: plan drafted 2026-08-08, implementation not started.

## Deliverables

1. **`packages/snap`** — the snap itself (npm-published, eventually allowlisted).
2. **`packages/connector`** — TypeScript dapp library: Freighter-compatible client + **Stellar Wallets Kit module**.
3. **`packages/site`** — companion dapp: install/connect, balances, send, friendbot, network switcher; doubles as the manual test bench.

## Phase 0 — Feasibility spikes (do these before committing to architecture)

- [ ] Scaffold with `yarn create @metamask/snap`; run template end-to-end on MetaMask Flask (Node ≥20.11).
- [ ] **Spike A — SDK under SES**: bundle `@stellar/stellar-sdk` (and separately just the `/base` subpath) into a snap; run `mm-snap eval` + a snaps-jest smoke test (`Keypair.fromRawEd25519Seed`, build+sign a tx, parse XDR). Decide: full SDK vs `/base` vs vendored subset. Measure bundle size.
- [ ] **Spike B — derivation**: `snap_getBip32Entropy` `["m","44'","148'"]` ed25519 → `SLIP10Node.fromJSON` → `derive(["slip10:0'"])` → `Keypair.fromRawEd25519Seed(privateKeyBytes)`. Validate against SEP-5 test vectors (fixed-mnemonic testing via snaps-jest if supported; otherwise unit-test the derivation fn against SLIP-10 vectors + manual Flask check with a known SRP).
- [ ] **Spike C — CORS**: `fetch` from inside the snap to `horizon-testnet.stellar.org`, `soroban-testnet.stellar.org`, and 2–3 candidate mainnet RPC providers (Gateway.fm, Ankr, OnFinality). Record which accept `Origin: null`.

Exit criteria: signed testnet payment produced inside a Flask-installed snap, address matches Freighter for the same mnemonic.

## Phase 1 — Core snap MVP (testnet, Flask)

Manifest:
```json
"initialPermissions": {
  "snap_dialog": {},
  "snap_manageState": {},
  "endowment:rpc": { "dapps": true, "snaps": false },
  "endowment:network-access": {},
  "snap_getBip32Entropy": [{ "path": ["m", "44'", "148'"], "curve": "ed25519" }]
}
```

Modules:
- `keys/` — derivation (account index x'), strkey helpers; keys re-derived per request, zeroized after use where possible.
- `rpc/` — router with per-method Superstruct/zod validation; sanitized errors (NEAR pattern: internal details never leak); origin metadata on every handler.
- `state/` — versioned state schema `{ version, activeNetwork, networks[], origins: { [origin]: { connectedAt, grants } } }` via `snap_manageState`.
- `stellar/` — thin Horizon + Stellar RPC clients (fetch), `getAccount` (sequence), `simulateTransaction`, `sendTransaction`+poll, friendbot.
- `ui/` — JSX dialog components (see Phase 2).

RPC methods (SEP-43 shapes + Freighter option bags):
| Method | Behavior |
|---|---|
| `requestAccess` | connect dialog → store origin grant → `{ address }` |
| `getAddress` | silent if origin granted; else error/empty (Freighter semantics) |
| `getNetwork` / `getNetworkDetails` | `{ network, networkPassphrase, networkUrl, sorobanRpcUrl }` |
| `setNetwork` | dialog-confirmed network switch (mainnet/testnet/futurenet) |
| `signTransaction` | parse XDR → validate network passphrase → dialog → sign → `{ signedTxXdr, signerAddress }`; `submit: true` optionally submits |
| `signMessage` | SEP-53 → `{ signedMessage, signerAddress }` |
| `fund` | testnet-only friendbot |
| `getBalances` | Horizon account balances (for companion dapp) |

Error model: SEP-43 codes (−1/−2/−3/−4); user rejection = −4 with Freighter's message string.

Dialog v1 (classic txs): source, network banner, sequence, fee, memo (+ MEMO_ID emphasis), per-operation sections for `payment`, `createAccount`, `changeTrust`, `pathPayment*`, `manageData`, `setOptions` (danger-flagged), `accountMerge` (danger-flagged); unknown ops → raw-XDR warning screen. Seq-0 detection ⇒ "Authentication request (SEP-10)" framing, no balance impact claim.

Testing: snaps-jest suite (derivation vectors, per-method happy/reject paths, dialog rendering assertions via `toRender`), `mm-snap eval` in CI.

## Phase 2 — Soroban depth

- [ ] `signTransaction` for Soroban txs: enforce single-op/MEMO_NONE, **re-simulate in-snap before dialog** → show resource fee vs inclusion fee, decoded invocation (contract C-address, function, `scValToNative` args), events summary, `restorePreamble` handling (offer restore-then-retry flow).
- [ ] `signAuthEntry`: decode entry, render invocation tree + nonce + `signatureExpirationLedger` (with ledger→time estimate), sign HashIdPreimage. Support the `authorizeEntry` callback shape.
- [ ] Token balances via Stellar Asset Contract / `getLedgerEntries` for SAC + custom tokens; `addToken({ contractId })` Freighter-parity method.
- [ ] Fee-bump envelope support (display inner tx + who pays).
- [ ] Multisig awareness: if account thresholds not met by our key, return signed XDR with an "insufficient weight — pass to co-signers" notice instead of failing.

## Phase 3 — Connector package + Wallets Kit module

- [ ] `packages/connector` (`@<scope>/stellar-snap-connector`): EIP-6963 detection (exact rdns match), `wallet_requestSnaps` with version pinning, typed SEP-43 client, Freighter-API-compatible facade (drop-in for `@stellar/freighter-api` users), `WatchWalletChanges`-style polling helper.
- [ ] **Stellar Wallets Kit ModuleInterface implementation** + upstream PR to Creit-Tech/Stellar-Wallets-Kit (this is the adoption lever — NEAR's wallet-selector module and Sui's wallet-standard adapter prove it).
- [ ] Companion dapp built on the connector: connect, balances (XLM + trustlines + Soroban tokens), send with memo, network switch, friendbot, sign-message demo, a Soroban contract-invoke demo (testnet).

## Phase 4 — Polish

- [ ] `onInstall` welcome dialog (link to companion dapp), `onHomePage`: address + balances + network + "open wallet" links.
- [ ] `snap_getPreferences` locale → i18n scaffold (XRPL/NEAR pattern); English first.
- [ ] SEP-29 memo-required warning; unfunded-destination detection (`payment` → suggest `createAccount`).
- [ ] Optional later: SEP-7 URI handling, SEP-10 helper flow in connector, `snap_notify` tx-status notifications, muxed address (M...) display support.

## Phase 5 — Audit & distribution

- [ ] Pre-audit hardening: remove console logs/TODOs/unused permissions (directory requirements), Snapper scan, threat-model doc (display-integrity claims, key lifecycle).
- [ ] Third-party audit (entropy permission is audit-gated; candidates: OtterSec, Cure53, Halborn, Least Authority, Veridise — check current MetaMask wiki list). Pin audited commit.
- [ ] npm publish (matching manifest/package fields, SVG icon), Directory Information form, allowlisting review (≥2 approvals, version-pinned — every release needs re-submission).
- [ ] Mainnet RPC strategy final call (provider with `Origin: null` CORS, or our own proxy).

## Open questions (resolve during Phase 0–1)

1. Multiple accounts (index x' > 0) in v1, or single account like Sui? Leaning: support index param in API from day 1, UI for it later.
2. Submit-in-snap (`submit: true`) in v1 or leave broadcasting to dapps? Leaning: support both; connector defaults to dapp-side submit.
3. Full stellar-sdk vs `/base`-only + hand-rolled fetch clients — decided by Spike A bundle size/SES result.
4. snaps-jest: can we inject a fixed SRP for end-to-end derivation vector tests? If not, restructure so the SLIP-10 math is testable in isolation.
5. Custom networks (user-supplied RPC/passphrase, e.g. standalone) — Freighter supports `STANDALONE`; probably post-MVP.

## Success criteria

- Same mnemonic in MetaMask and Freighter → same `G...` address (SEP-5 vectors green).
- A stock Stellar Wallets Kit dapp can connect, sign a classic payment, sign a Soroban `transfer` with auth entry, and authenticate via SEP-10 — all with honest, decoded confirmation dialogs.
- Allowlisted on stable MetaMask with a public audit report.
