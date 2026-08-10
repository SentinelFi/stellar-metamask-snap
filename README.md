# Stelllar MetaMask Snap

A MetaMask Snap bringing the **Stellar network (including Soroban smart contracts)** to MetaMask: SEP-0005-compatible key derivation from the MetaMask Secret Recovery Phrase, a SEP-43 / Freighter-compatible signing API for dapps, and a Stellar Wallets Kit module for ecosystem-wide integration.

> Independent software, not affiliated with or endorsed by the Stellar Development Foundation.

**Status:** Phase 1 (core snap MVP) complete — SEP-43 wallet API with per-operation confirmation dialogs, origin grants, and network state; see [docs/PHASE-1.md](docs/PHASE-1.md). Phase 2 (Soroban depth) is next. Phase 0 feasibility results: [docs/PHASE-0.md](docs/PHASE-0.md).

## Development

```bash
yarn install
```

```bash
yarn workspace stellar-soroban-snap build
```

```bash
yarn workspace stellar-soroban-snap test
```

`yarn start` serves the snap at `localhost:8080` and the companion dapp at `localhost:8000` for installation into MetaMask Flask.

## Documentation

- [docs/MENTAL-MAP.md](docs/MENTAL-MAP.md) — architecture, key decisions, and risk map
- [docs/PLAN.md](docs/PLAN.md) — phased implementation plan
- Knowledge base ([docs/research/](docs/research/)):
  - [metamask-snaps-platform.md](docs/research/metamask-snaps-platform.md) — Snaps runtime, permissions, entry points, UI, testing, allowlisting
  - [stellar-soroban.md](docs/research/stellar-soroban.md) — Stellar accounts/transactions, SEP-5 derivation, Soroban simulation & auth entries, wallet interop SEPs
  - [example-snaps-analysis.md](docs/research/example-snaps-analysis.md) — code analysis of the XRPL, Sui, and NEAR snaps + the existing `stellar-snap`

## Approach

- Derive ed25519 keys at `m/44'/148'/x'` via `snap_getBip32Entropy` — same addresses as Freighter/Ledger for the same mnemonic.
- Expose the five SEP-43 methods (`getAddress`, `signTransaction`, `signAuthEntry`, `signMessage`, `getNetwork`) with Freighter-compatible semantics.
- Simulate Soroban transactions in-snap before signing to show real resource fees, decoded invocations, and balance effects.
- Ship a connector npm package + Stellar Wallets Kit module so existing Stellar dapps get MetaMask support for free.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please see [SECURITY.md](SECURITY.md) for how to report security issues.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

Copyright © 2026.
