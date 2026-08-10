# Implementation Plan — Stellar Soroban MetaMask Snap

> Companion to [MENTAL-MAP.md](MENTAL-MAP.md) (decisions & rationale) and [docs/research/](research/) (knowledge base).
> Status: plan drafted 2026-08-08, implementation not started.

## Deliverables

1. **`packages/snap`** — the snap itself (npm-published, eventually allowlisted).
2. **`packages/connector`** — TypeScript dapp library: Freighter-compatible client + **Stellar Wallets Kit module**.
3. **`packages/site`** — companion dapp: install/connect, balances, send, friendbot, network switcher; doubles as the manual test bench.

## Process rule: tag every completed phase

When a phase is complete — and **before** starting the next one — create an annotated git tag on the phase's final commit and push it (`git push --tags`):

```bash
git tag -a phase-N <commit> -m "Phase N complete: <one-line summary>"
```

Each tag preserves the exact snap + companion-dapp pair for that phase, so anyone can `git checkout phase-N && yarn install && yarn start` to run it as it was. This is the historical record; old phase methods/UI are NOT kept alive on `main` (dead RPC surface in a key-handling snap is an audit liability). Existing tags: `phase-0` (0cc70cf).

## Phase 0 — Feasibility spikes — ✅ DONE 2026-08-08 (results: [PHASE-0.md](PHASE-0.md))

- [x] Scaffold with `@metamask/create-snap`; template builds & tests green (monorepo merged into repo root).
- [x] **Spike A — SDK under SES**: full `@stellar/stellar-sdk ^16.2.0` builds, passes `mm-snap eval`, runs in the simulator; bundle 505 KB tree-shaken — `/base` subpath not needed yet. ⚠️ benign `Math.random` warning from bignumber.js (unused code path) — document for audit.
- [x] **Spike B — derivation**: `snap_getBip32Entropy` m/44'/148' ed25519 + SLIP10 child derivation **matches official SEP-5 test vectors exactly** (snaps-jest with `secretRecoveryPhrase` option; indexes 0 and 1).
- [x] **Spike C — CORS**: all endpoints accept `Origin: null` incl. preflight (SDF testnet echo `null`; Gateway.fm/Ankr/OnFinality/Lightsail return `*`). No proxy needed.

Exit criteria: simulator-signed payment + vector-matched addresses ✅; **manual Flask check still outstanding** (needs a browser with Flask — see PHASE-0.md).

## Phase 1 — Core snap MVP (testnet, Flask) — ✅ DONE 2026-08-10 (notes: [PHASE-1.md](PHASE-1.md))

All items below implemented as specified (19 tests green, lint clean, SES eval passing). Deviations: strict network-passphrase mismatch error instead of Freighter's warn-and-sign; approved signatures auto-grant the origin; `submit: true` is best-effort pending the Phase 2 RPC client. Fee-bump display, planned for Phase 2, shipped early.

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

## Phase 2 — Soroban depth — ✅ CORE DONE 2026-08-10 (notes: [PHASE-2.md](PHASE-2.md))

- [x] `signTransaction` for Soroban txs: **in-snap display-verification simulation before the dialog** → estimated resource fee, decoded invocation (contract C-address, function, `scValToNative` args), required auth signers, `restorePreamble` **warning** (guided restore-then-retry flow deferred to Phase 4). Simulation failure renders a warning, never blocks review.
- [x] `signAuthEntry`: decodes the entry, renders the invocation tree + nonce + `signatureExpirationLedger`, signs the HashIdPreimage via the SDK's `authorizeEntry`; preserves the dapp's expiration (defaults to latest+60 when unset).
- [ ] Token balances via SAC simulation + `addToken({ contractId })` — **deferred to Phase 4** (belongs with home-page balance display; not dapp-compatibility surface).
- [x] Fee-bump envelope support (display inner tx + who pays) — shipped early in Phase 1.
- [ ] Multisig awareness: if account thresholds not met by our key, return signed XDR with an "insufficient weight — pass to co-signers" notice instead of failing. **Deferred to Phase 4** (needs signer/threshold fetching + per-op source handling).

## Phase 3 — Connector package + Wallets Kit module

- [ ] `packages/connector` (`@<scope>/stellar-snap-connector`): EIP-6963 detection (exact rdns match), `wallet_requestSnaps` with version pinning, typed SEP-43 client, Freighter-API-compatible facade (drop-in for `@stellar/freighter-api` users), `WatchWalletChanges`-style polling helper.
- [ ] **Stellar Wallets Kit ModuleInterface implementation** + upstream PR to Creit-Tech/Stellar-Wallets-Kit (this is the adoption lever — NEAR's wallet-selector module and Sui's wallet-standard adapter prove it).
- [ ] Companion dapp built on the connector: connect, balances (XLM + trustlines + Soroban tokens), send with memo, network switch, friendbot, sign-message demo, a Soroban contract-invoke demo (testnet).

## Phase 4 — Polish

- [ ] `onInstall` welcome dialog (link to companion dapp). ~~`onHomePage`: address + balances + network~~ — **done early in Phase 2** (see [PHASE-2.md](PHASE-2.md)).
- [ ] `snap_getPreferences` locale → i18n scaffold (XRPL/NEAR pattern); English first.
- [ ] SEP-29 memo-required warning; unfunded-destination detection (`payment` → suggest `createAccount`).
- [ ] Optional later: SEP-7 URI handling, SEP-10 helper flow in connector, `snap_notify` tx-status notifications, muxed address (M...) display support.

## Upstream contribution (file early — external review latency)

- [ ] PR to [MetaMask/snaps](https://github.com/MetaMask/snaps) `packages/snaps-utils/src/derivation-paths.ts` adding `{ path: ['m', "44'", "148'"], curve: 'ed25519', name: 'Stellar' }` so the install prompt says "Manage **Stellar** accounts" instead of "Unknown network". Cosmetic but trust-relevant; see [PHASE-0.md](PHASE-0.md) for the root-cause analysis. Should land before allowlisting.

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
