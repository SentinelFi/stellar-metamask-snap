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
- [x] Token balances via SAC simulation + `addToken({ contractId })`: deferred from Phase 2 to Phase 4 (belongs with home-page balance display; not dapp-compatibility surface), **shipped in Phase 4** (`src/stellar/token.ts`, `src/handlers/account.tsx`).
- [x] Fee-bump envelope support (display inner tx + who pays) — shipped early in Phase 1.
- [x] Multisig awareness: if account thresholds are not met by our key, return signed XDR with an "insufficient weight, pass to co-signers" notice instead of failing. Deferred from Phase 2 to Phase 4 (needed signer/threshold fetching plus per-op source handling), **shipped in Phase 4** (`src/stellar/safety.ts`; surfaced as a dialog banner and in the `warnings` result field).

## Phase 3 — Connector package + Wallets Kit module — ✅ DONE 2026-08-10 (notes: [PHASE-3.md](PHASE-3.md))

- [x] `packages/connector` (`stellar-soroban-snap-connector`): EIP-6963 detection (exact rdns match), `wallet_requestSnaps` with version pinning, typed SEP-43 client (`StellarSnap`, throws `StellarSnapError` with SEP-43 codes), Freighter-API-compatible facade (`createFreighterApi`, `{ ...result, error? }` convention), `WatchWalletChanges` polling helper. Zero runtime deps; 8 unit tests over a mock provider.
- [x] **Stellar Wallets Kit ModuleInterface implementation** (`StellarSnapKitModule`, structural — no kit dependency; verified against the kit's current interface). Upstream PR to Creit-Tech/Stellar-Wallets-Kit **deferred until the snap is npm-published + allowlisted** (the kit lists production wallets; `npm:stellar-soroban-snap` must resolve first).
- [x] Companion dapp rebuilt on the connector: all actions through typed `StellarSnap` methods (raw `wallet_invokeSnap` plumbing removed).

## Phase 4 — Polish — ✅ CORE DONE 2026-08-10 (notes: [PHASE-4.md](PHASE-4.md))

- [x] `onInstall` welcome dialog. ~~`onHomePage`: address + balances + network~~ — done early in Phase 2.
- [x] SEP-29 memo-required warning; unfunded-destination detection; unfunded-source and multisig-weight warnings — advisory banners in the signing dialog ([stellar/safety.ts](../packages/snap/src/stellar/safety.ts)).
- [x] **Token balances + `addToken`** (the Phase 2 deferral): per-network token registry in state, SEP-41 metadata/balance reads via simulation, home-page + `getBalances` display, connector method, dapp card.
- [x] Multisig awareness (the Phase 2 deferral): insufficient-weight warning against the account's medium threshold.
- [ ] `snap_getPreferences` locale → i18n scaffold — **deferred** (English-only acceptable for launch; extract a string catalog once copy stabilizes).
- [ ] Optional later: SEP-7 URI handling, SEP-10 helper flow in connector, `snap_notify` tx-status notifications, muxed address (M...) display, guided restore-then-retry flow.
- [ ] Emerging token standards (all drafts as of 2026-08; signing/authorization already works generically for every contract type): SEP-50 NFT-aware display (`owner_of`/enumeration; note snap dialogs render inline SVG only — no remote NFT images), SEP-56 vault share valuation (`convert_to_assets` alongside the share balance `addToken` can already track), SEP-57 T-REX (balances already trackable; compliance rejections surface via simulation).

## Upstream contribution (file early — external review latency)

- [x] **Merged 2026-08-17:** [MetaMask/snaps#4097](https://github.com/MetaMask/snaps/pull/4097) — adds `{ path: ['m', "44'", "148'"], curve: 'ed25519', name: 'Stellar' }` to `packages/snaps-utils/src/derivation-paths.ts` (+ unit test) so the install prompt says "Manage **Stellar** accounts" instead of "Unknown network". Cosmetic but trust-relevant; see [PHASE-0.md](PHASE-0.md) for the root-cause analysis. Landed as commit `22be130`; ships with the next `@metamask/snaps-utils` release and reaches users when the MetaMask extension picks that release up, so re-verify the install prompt label in a current MetaMask before the Directory submission screenshots.

## Phase 5 — Audit & distribution — ✅ PREPARATION DONE 2026-08-10 (notes: [PHASE-5.md](PHASE-5.md)); external steps pending

- [x] Pre-audit hardening: zero console logs / TODOs across all packages (site's template `console.error`s stripped); permission-usage mapping documented — no unused permissions.
- [x] Threat-model doc: [THREAT-MODEL.md](THREAT-MODEL.md) (assets, trust boundaries, six attackable security claims, code map, residual risks).
- [x] npm publish readiness: package READMEs + LICENSE files, metadata verified, pack contents verified by dry-run for both packages.
- [x] Mainnet RPC decision: Gateway.fm RPC + SDF Horizon (CORS-verified); re-probe before submission; drop-in alternates documented.
- [ ] **Snapper security scan** (CI workflow builds from source; on the frozen pre-publish commit) — assessment: [research/snapper-security-scan.md](research/snapper-security-scan.md).
- [ ] **Third-party audit** (mandatory — audit-gated entropy permission); then freeze, re-probe CORS, Snapper, tag.
- [x] **npm publish (name reservation)**: `v0.1.0` of both packages published 2026-08-27 via the release workflow's bootstrap path, trusted publishing configured, token deleted. `0.1.0` is the pre-audit build; the audited release is `0.1.1+` (see RELEASE.md "First release and the audited release").
- [ ] **Audited npm release** (`0.1.1+`, after audit + freeze); **Directory Information form** (draft in PHASE-5.md) + ≥2-approval review; after allowlisting: Wallets Kit upstream PR.

## Open questions (resolve during Phase 0–1)

1. Multiple accounts (index x' > 0) in v1, or single account like Sui? Leaning: support index param in API from day 1, UI for it later. Resolved 2026-08-12: implemented per [MULTI-ACCOUNT.md](MULTI-ACCOUNT.md) (account registry, home-page add/switch, `getAccounts`/`setActiveAccount`, SEP-43 `address` resolution).
2. Submit-in-snap (`submit: true`) in v1 or leave broadcasting to dapps? Leaning: support both; connector defaults to dapp-side submit.
3. Full stellar-sdk vs `/base`-only + hand-rolled fetch clients — decided by Spike A bundle size/SES result.
4. snaps-jest: can we inject a fixed SRP for end-to-end derivation vector tests? If not, restructure so the SLIP-10 math is testable in isolation.
5. Custom networks (user-supplied RPC/passphrase, e.g. standalone) — Freighter supports `STANDALONE`; probably post-MVP.

## Success criteria

- Same mnemonic in MetaMask and Freighter → same `G...` address (SEP-5 vectors green).
- A stock Stellar Wallets Kit dapp can connect, sign a classic payment, sign a Soroban `transfer` with auth entry, and authenticate via SEP-10 — all with honest, decoded confirmation dialogs.
- Allowlisted on stable MetaMask with a public audit report.
