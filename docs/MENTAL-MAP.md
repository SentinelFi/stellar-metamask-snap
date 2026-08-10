# Mental Map — Stellar Soroban MetaMask Snap

> How all the pieces fit together. Details live in [docs/research/](research/); the build sequence lives in [PLAN.md](PLAN.md).

## The one-paragraph thesis

MetaMask has no Stellar support and its Keyring API is closed to third parties, so the integration path is a **classic non-EVM snap**: derive SEP-0005-compatible ed25519 keys from the user's MetaMask Secret Recovery Phrase via `snap_getBip32Entropy` (`m/44'/148'`, curve ed25519), expose a **SEP-43 / Freighter-shaped RPC API** (`getAddress`, `signTransaction`, `signAuthEntry`, `signMessage`, `getNetwork`) to dapps through `wallet_invokeSnap`, render **simulation-driven confirmation dialogs** for every signature, and ship a **Stellar Wallets Kit module** so every existing Stellar dapp can list "MetaMask" as a wallet with zero per-dapp work. The only existing Stellar snap (`stellar-snap`, <1K installs) uses non-standard key derivation incompatible with Freighter/Ledger — standards compliance is our differentiation.

## System diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│ Stellar dapp (any dapp using Stellar Wallets Kit or Freighter API)   │
│   └── our Wallets-Kit module / connector lib (npm package)           │
│         maps SEP-43 calls → wallet_invokeSnap                        │
├──────────────────────────────────────────────────────────────────────┤
│ MetaMask (stable, once allowlisted; Flask during dev)                │
│   wallet_requestSnaps / wallet_invokeSnap / wallet_getSnaps          │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │ THE SNAP (SES sandbox, npm:<package>)                      │    │
│   │  onRpcRequest ─ router ─ per-method handlers               │    │
│   │  keys: snap_getBip32Entropy m/44'/148' ed25519             │    │
│   │        → SLIP10Node.derive(x') → Keypair (never stored)    │    │
│   │  UI: snap_dialog + JSX (tx review, auth-entry review)      │    │
│   │  state: snap_manageState (network, per-origin grants)      │    │
│   │  net: fetch → Horizon + Stellar RPC (simulate, sequence,   │    │
│   │        balances, submit)                                   │    │
│   │  extras: onHomePage, onInstall                             │    │
│   └────────────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────────┤
│ Stellar network                                                      │
│   Horizon (accounts/history/classic submit)                          │
│   Stellar RPC (simulateTransaction, sendTransaction, getTransaction, │
│                getLedgerEntries)                                     │
│   friendbot (testnet funding)                                        │
└──────────────────────────────────────────────────────────────────────┘
```

Plus a **companion dapp** (`packages/site`): install/connect UI, balances, send XLM/assets, network switcher, friendbot button — and the dev-test surface.

## Key decisions (with reasons)

| Decision       | Choice                                                                                                                                                                               | Why                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Key derivation | `snap_getBip32Entropy` `["m","44'","148'"]` ed25519; derive `x'` in-snap via `SLIP10Node`; verify against SEP-5 test vectors                                                         | Freighter/Ledger/Lobstr-compatible addresses from the same mnemonic; the incumbent snap can't offer this without breaking users. BIP-44 entropy is secp256k1-only — unusable.                                                                                                              |
| Keys at rest   | Re-derive on demand; never persist private keys; no key-export RPC                                                                                                                   | Sui/NEAR pattern; smallest audit surface. XRPL's `extractPrivateKey` and stellar-snap's `dispPrivateKey` are anti-patterns.                                                                                                                                                                |
| Dapp API shape | SEP-43 five methods + Freighter option bags & error codes (−4 = user rejected)                                                                                                       | It's the documented standard AND the de-facto one; makes the Wallets-Kit module a thin 1:1 wrapper.                                                                                                                                                                                        |
| Network access | Yes (`endowment:network-access`)                                                                                                                                                     | Soroban UX requires in-snap `simulateTransaction` (fees, balance changes, auth entries, restorePreamble) before showing the dialog — the Sui snap proved this is the best-in-class pattern. Also enables sequence autofill and optional submit. CORS: endpoints must allow `Origin: null`. |
| Connect model  | Explicit per-origin connect grant (NEAR pattern): `requestAccess` dialogs once, `getAddress` silent thereafter for granted origins                                                   | Avoids XRPL's silent-fingerprint problem; matches Freighter's `isAllowed`/`setAllowed` semantics.                                                                                                                                                                                          |
| Signing scope  | Whitelist of displayable operation types with typed dialogs; unknown ops → explicit raw-XDR warning path; **never sign bare hashes**                                                 | XRPL strategy-pattern precedent; auditors look for exactly this.                                                                                                                                                                                                                           |
| Tx display     | Parse XDR in-snap (source of truth); simulation results for Soroban (resource fee, invocation tree, expiration ledger); SEP-10 seq-0 challenges get special "authentication" framing | Never trust dapp-provided summaries.                                                                                                                                                                                                                                                       |
| State          | `snap_manageState` (encrypted default): active network, custom RPC URLs, per-origin grants, display prefs. No accounts (re-derived), no keys.                                        | Minimal, non-sensitive-ish, migration-friendly.                                                                                                                                                                                                                                            |
| SDK            | `@stellar/stellar-sdk` v16+; prefer `/base` subpath in signing paths; network calls via thin fetch client or SDK servers — decide by bundle size + `mm-snap eval` result             | stellar-base is folded into the SDK; pure-JS crypto should survive SES — verify early (Phase 0 spike).                                                                                                                                                                                     |
| Distribution   | npm package + Snaps Directory allowlisting; **third-party audit required** (entropy permission is audit-gated)                                                                       | Without allowlisting the snap only runs on Flask. Budget audit into the timeline.                                                                                                                                                                                                          |

## The three signing payloads (heart of the snap)

1. **Transaction envelope**: sign `SHA256(SHA256(passphrase) ‖ envelopeType ‖ txXDR)`, append `DecoratedSignature{hint, sig}`. Covers classic ops, fee-bumps, Soroban txs, seq-0 SEP-10 challenges.
2. **Soroban auth entry** (address credentials): sign `SHA256(HashIdPreimage(sorobanAuth){networkId, nonce, invocation, signatureExpirationLedger}.toXDR())`, embed as ScVal. This is `signAuthEntry` — required for dapps using their own fee source.
3. **SEP-53 message**: sign `SHA256("Stellar Signed Message:\n" + msg)`.

## Where the risk lives

- **Derivation correctness** — a mistake here loses funds or strands users. Mitigation: SEP-5 official test vectors as unit tests; snap_getBip32PublicKey cross-check.
- **Display integrity** — the dialog must reflect the XDR actually signed (memo, amounts, `accountMerge`/`setOptions` flagged as dangerous, auth-entry invocation trees decoded).
- **SES compatibility of stellar-sdk** — unverified; Phase 0 spike (`mm-snap eval` + snaps-jest smoke test). Fallback: `/base` subpath only, hand-rolled fetch clients, or (worst case) vendored XDR + tweetnacl.
- **CORS on mainnet RPC providers** — must test `Origin: null` against candidate providers; may need a proxy.
- **Allowlisting timeline** — audit + 2-approval review is weeks-to-months; Flask-only until then.

## Ecosystem context worth remembering

- MetaMask went native multichain in 2025 (Solana, Bitcoin via preinstalled first-party snaps). If Stellar ever goes native, SEP-5 derivation is what they'd use — our addresses would migrate cleanly.
- The incumbent `stellar-snap` is audited (Cure53) and allowlisted but pre-JSX (platformVersion 6.10), salt-derived keys, no connector ecosystem, <1K installs. We compete on standards, Soroban depth, and dapp integration, not on being first.
- Stellar Wallets Kit is the distribution channel: one module ≈ every major Soroban dapp.
