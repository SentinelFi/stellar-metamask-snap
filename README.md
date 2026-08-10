# Stelllar MetaMask Snap

[![CI](https://github.com/jeffnuclear/stelllar-metamask-snap/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffnuclear/stelllar-metamask-snap/actions/workflows/ci.yml)

A MetaMask Snap bringing the **Stellar network (including Soroban smart contracts)** to MetaMask: SEP-0005-compatible key derivation from the MetaMask Secret Recovery Phrase, a SEP-43 / Freighter-compatible signing API for dapps, and a Stellar Wallets Kit module for ecosystem-wide integration.

> Independent software, not affiliated with or endorsed by the Stellar Development Foundation.

**Status:** Feature-complete; Phase 5 (audit & distribution) preparation done — hardening sweep, [threat model](docs/THREAT-MODEL.md), npm-publish readiness; remaining steps are external (third-party audit, npm publish, directory allowlisting) — see [docs/PHASE-5.md](docs/PHASE-5.md). Phase history: [4](docs/PHASE-4.md) polish · [3](docs/PHASE-3.md) connector · [2](docs/PHASE-2.md) Soroban · [1](docs/PHASE-1.md) SEP-43 API · [0](docs/PHASE-0.md) feasibility.

## FAQ

<details>
<summary><strong>What is Stellar?</strong></summary>

An open-source, fast, low-cost blockchain network for payments and issuing digital assets. Learn more at [stellar.org](https://stellar.org).

</details>

<details>
<summary><strong>What is Soroban?</strong></summary>

Stellar's smart contracts platform. Learn more at [stellar.org/soroban](https://stellar.org/soroban).

</details>

<details>
<summary><strong>What is MetaMask?</strong></summary>

A self-custodial crypto wallet. Learn more at [metamask.io](https://metamask.io).

</details>

<details>
<summary><strong>What is a MetaMask Snap?</strong></summary>

A sandboxed extension that adds new capabilities to MetaMask. Learn more at [metamask.io/snaps](https://metamask.io/snaps).

</details>

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

Audit reports are available in [audits/](audits/).

> **Disclaimer: use at your own risk.** We are committed to making this software as secure as possible through standards-compliant design, testing, and a planned third-party audit, but no software can be guaranteed free of vulnerabilities, and nothing here is a guarantee of security. It is provided "as is", without warranty of any kind, express or implied. You are solely responsible for reviewing the code and assessing its suitability before use. Interacting with blockchain networks carries inherent risk, including the irreversible loss of funds. The authors and contributors accept no liability for any loss or damage arising from its use.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

Copyright © 2026.
