# Phase 4 — Polish: Implementation Notes

> Built 2026-08-10. Plan reference: [PLAN.md](PLAN.md) Phase 4. Predecessors: Phases 0–3.
> Status: **complete** — onInstall welcome, pre-sign safety warnings, and Soroban token support (`addToken` + token balances). 30 snap tests + 8 connector tests green, lint clean, SES eval passing.

## What shipped

### `onInstall` welcome dialog

`endowment:lifecycle-hooks` + `onInstall` ([handlers/install.tsx](../packages/snap/src/handlers/install.tsx)): a one-time alert after installation explaining what the snap does (SEP-0005 Stellar account, Freighter/Ledger-compatible), that it starts on TESTNET, that dapps must request access, and where to view balances (MetaMask menu → Snaps → Stellar Soroban).

### Pre-sign safety warnings (classic transactions)

[stellar/safety.ts](../packages/snap/src/stellar/safety.ts) runs best-effort Horizon checks before the signing dialog and renders any findings as warning banners **above** the transaction summary (and returns them in the `signTransaction` result as `warnings[]`):

- **Unfunded destination** — a `payment`/`pathPayment` to an account that does not exist on the ledger will fail; the dialog says so and suggests `createAccount`.
- **SEP-29 memo required** — the destination carries a `config.memo_required` data entry but the transaction has no memo (a classic way to lose exchange deposits).
- **Unfunded source** — the source account does not exist on the active network.
- **Multisig weight** — the wallet key's weight is below the account's medium threshold, so the signed transaction will need co-signers before submission (heuristic on the medium threshold; not a full per-operation analysis).

All checks are **advisory and degrade silently**: Horizon lookups are time-bounded (5s) and capped (≤3 destinations), and unreachability never blocks signing or produces a false "safe". The transaction being signed is never modified.

### Soroban token support (`addToken` + balances)

The big Phase 2 deferral. Tokens are tracked per network in encrypted state ([state/index.ts](../packages/snap/src/state/index.ts): `tokens?: Partial<Record<NetworkName, TrackedToken[]>>`).

- **`addToken({ contractId, networkPassphrase? })`** ([handlers/account.tsx](../packages/snap/src/handlers/account.tsx)): validates the `C...` contract ID, reads the token's SEP-41 `symbol`/`decimals` **via read-only simulation** ([stellar/token.ts](../packages/snap/src/stellar/token.ts) — the metadata shown is read from the contract, never dapp-supplied), confirms with a dialog, and stores it. Requires a connected origin. Freighter-parity method.
- **`getBalances`** now appends tracked-token balances (read via `balance(address)` simulation, formatted with the token's decimals) after the classic Horizon balances.
- **Home page** shows tracked-token balances alongside XLM.

Read calls are self-contained: a throwaway source account, `setTimeout`-bounded simulation, and any failure (unreachable RPC, non-token contract) degrades to "skip this token" rather than throwing.

### Connector

`StellarSnap.addToken(contractId, networkPassphrase?)` and a `warnings?: string[]` field on the `signTransaction` result. Companion dapp gains an **Add token** card (contract-ID input + button).

## Testing (30 snap tests; 4 new in [phase4.test.tsx](../packages/snap/src/phase4.test.tsx))

- `onInstall` renders the welcome dialog.
- `signTransaction` still reviews and signs a payment to an unfunded destination (the safety layer is advisory — it augments, never blocks).
- `addToken` rejects invalid contract IDs (`-3`) and unconnected origins (`-3`).

Live-network behaviors (successful `addToken` metadata read, token balance formatting) are exercised manually against testnet — they require a deployed token contract and are network-dependent, so the automated suite asserts the offline guards and the deterministic error paths.

## Deferred (with rationale)

- **i18n scaffold** (`snap_getPreferences` locale → translated strings): the dialog copy is centralized enough to localize later; English-only is acceptable for launch and the sensible first step is extracting a string catalog, which is mechanical and better done once the copy stabilizes.
- **SEP-7 URI handling / SEP-10 helper flow / `snap_notify` tx-status**: additive dapp/UX features, not correctness or compatibility gaps. Candidates for a post-launch Phase 6.
- **Restore-then-retry flow** for `restorePreamble`: the dialog already warns loudly; the guided flow needs its own consent UX and is lower value than shipping.
- **Muxed address (`M...`) display**: rare in practice; the raw XDR review covers it until demand appears.

## Manual test drive

`yarn start`, then in the Flask profile:

1. **Fresh install** (remove + reinstall the snap) → the **welcome dialog** appears.
2. **Sign payment** with an edited destination that is unfunded → the dialog shows an **unfunded-destination warning** above the summary.
3. **Add token**: paste a testnet token contract ID (e.g. the XLM SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`) → confirm the **Add token** dialog showing the read symbol/decimals → then **Balances** and the **home page** include the token line.
