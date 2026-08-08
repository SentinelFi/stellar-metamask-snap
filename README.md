# stelllar-metamask-snaps

A MetaMask Snap bringing the **Stellar network (including Soroban smart contracts)** to MetaMask: SEP-0005-compatible key derivation from the MetaMask Secret Recovery Phrase, a SEP-43 / Freighter-compatible signing API for dapps, and a Stellar Wallets Kit module for ecosystem-wide integration.

**Status: research & planning.** Implementation has not started yet.

## Documentation

- [docs/MENTAL-MAP.md](docs/MENTAL-MAP.md) — architecture, key decisions, and risk map
- [docs/PLAN.md](docs/PLAN.md) — phased implementation plan
- Knowledge base ([docs/research/](docs/research/)):
  - [metamask-snaps-platform.md](docs/research/metamask-snaps-platform.md) — Snaps runtime, permissions, entry points, UI, testing, allowlisting
  - [stellar-soroban.md](docs/research/stellar-soroban.md) — Stellar accounts/transactions, SEP-5 derivation, Soroban simulation & auth entries, wallet interop SEPs
  - [example-snaps-analysis.md](docs/research/example-snaps-analysis.md) — code analysis of the XRPL, Sui, and NEAR snaps + the existing `stellar-snap`

## TL;DR of the approach

- Derive ed25519 keys at `m/44'/148'/x'` via `snap_getBip32Entropy` — same addresses as Freighter/Ledger for the same mnemonic (the existing `stellar-snap` doesn't do this; it's our main differentiator).
- Expose the five SEP-43 methods (`getAddress`, `signTransaction`, `signAuthEntry`, `signMessage`, `getNetwork`) with Freighter-compatible semantics.
- Simulate Soroban transactions in-snap before signing to show real resource fees, decoded invocations, and balance effects.
- Ship a connector npm package + Stellar Wallets Kit module so existing Stellar dapps get MetaMask support for free.
