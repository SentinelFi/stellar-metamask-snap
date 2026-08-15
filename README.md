# Stellar MetaMask Snap

[![CI](https://github.com/SentinelFi/stellar-metamask-snap/actions/workflows/ci.yml/badge.svg)](https://github.com/SentinelFi/stellar-metamask-snap/actions/workflows/ci.yml)

A MetaMask Snap bringing the **Stellar network (including Soroban smart contracts)** to MetaMask: SEP-0005-compatible key derivation from the MetaMask Secret Recovery Phrase, a SEP-43 / Freighter-compatible signing API for dapps, and a Stellar Wallets Kit module for ecosystem-wide integration.

> Independent software, not affiliated with or endorsed by the Stellar Development Foundation.

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

## Usage

> **Not yet published.** The snap is pending its third-party audit and MetaMask Directory allowlisting, so it is not on npm and cannot be installed in regular MetaMask yet. The install steps that follow describe the flow once the snap is live.

### Installing the snap

1. **Install MetaMask:** make sure you have the latest version of the MetaMask extension in your browser.
2. **Open a dapp that supports the snap:** any Stellar dapp built on [Stellar Wallets Kit](https://stellarwalletskit.dev) or on the [connector package](packages/connector), including this repository's companion dapp.
3. **Choose Stellar Soroban** in the dapp's wallet picker, or click its Connect button. The dapp asks MetaMask to install `npm:stellar-soroban-snap`.
4. **Review the install prompt:** MetaMask lists the permissions the snap requests (key derivation at `m/44'/148'`, dialogs, network access, storage, home page). Confirm to install.
5. **Approve access:** the snap then asks you to grant that dapp access to your Stellar address. Approving is what connects the two, and every later signature still needs its own confirmation.

Once installed, open the snap from the MetaMask menu → **Snaps** → **Stellar Soroban** to see your address, network, and balances, add further SEP-0005 accounts (or [find one you already hold](#bringing-an-existing-stellar-wallet)), switch the active account, or disconnect a dapp.

### Bringing an existing Stellar wallet

Your Stellar accounts here are derived from your MetaMask Secret Recovery Phrase along the standard SEP-0005 path `m/44'/148'/x'`: the same path Freighter, Lobstr, Ledger, and other Stellar wallets use. Whether an account you already hold shows up depends on which phrase it came from.

- **Created from the phrase MetaMask already holds.** It is already yours here, just not revealed yet. Open the snap home page and use **Find an account by address or index**: paste the `G…` address and the snap locates which account index it is and adds it. Accounts are kept gap-free (matching how other SEP-0005 wallets enumerate them), so reaching account 5 also reveals accounts 0 to 4; the confirmation says exactly how many it is adding.
- **Created from a different recovery phrase.** Import that phrase into MetaMask itself and the accounts follow automatically, with no import step in the snap. One caveat: the snap derives from MetaMask's **primary** recovery phrase, so adding your Stellar phrase as an additional phrase in MetaMask will not surface those accounts.
- **You only have the secret key (`S…`), not a recovery phrase.** This cannot be added. The snap has no way to accept an existing private key, deliberately: it derives keys on demand and never stores key material, which is what keeps its encrypted storage free of anything that could move your funds. Use a wallet that supports secret-key import, or transfer the balance to an account this wallet derives.

Only the address is ever searched for, entirely on your own device: no lookup leaves MetaMask, and nothing is added without your confirmation.

### Using it

- **Signing:** a dapp calls the SEP-43 API and MetaMask shows a confirmation dialog decoded from the transaction XDR itself, including a Soroban simulation for contract calls. Nothing is signed without your approval.
- **Networks:** TESTNET by default, with PUBLIC (mainnet) and FUTURENET available. The network passphrase is pinned into every signature.
- **Test funds:** on TESTNET and FUTURENET, a connected dapp can ask the snap to fund the account from friendbot. Only the wallet's own accounts can be funded.

### For dapp developers

Add the [connector package](packages/connector) and talk to the snap through a typed SEP-43 client, a drop-in `@stellar/freighter-api` facade, or a Stellar Wallets Kit module:

```ts
import { StellarSnap } from 'stellar-soroban-snap-connector';

const snap = new StellarSnap();
const { address } = await snap.connect();
const { signedTxXdr } = await snap.signTransaction(xdr);
```

## Development

```bash
yarn install
```

One-time per clone: activates the repo's git hooks (a pre-commit hook rebuilds the snap and refreshes the `snap.manifest.json` shasum whenever staged changes affect the bundle, so CI's manifest check cannot fail on a stale checksum):

```bash
yarn setup:hooks
```

```bash
yarn workspace stellar-soroban-snap build
```

```bash
yarn workspace stellar-soroban-snap test
```

The snap test script builds first, on purpose. `snaps-jest` runs the snap the way MetaMask does, by executing the built `dist/bundle.js` rather than the TypeScript sources, so a missing bundle makes the suite unrunnable and a stale one makes it pass against old code. The bundle is a build artifact and is deliberately not committed: the `shasum` in `snap.manifest.json` seals it, and a checked-in copy would be a second source of truth that reviewers could not diff meaningfully. Build it, do not fetch it.

`yarn start` serves the snap at `localhost:8080` and the companion dapp at `localhost:8000` for installation into MetaMask Flask.

## Documentation

- [CHANGELOG.md](CHANGELOG.md): release history
- [docs/RELEASE.md](docs/RELEASE.md): how a release is cut, and the four files that carry the version
- [docs/MENTAL-MAP.md](docs/MENTAL-MAP.md): architecture, key decisions, and risk map
- [docs/PLAN.md](docs/PLAN.md): phased implementation plan
- Knowledge base ([docs/research/](docs/research/)):
  - [metamask-snaps-platform.md](docs/research/metamask-snaps-platform.md): Snaps runtime, permissions, entry points, UI, testing, allowlisting
  - [stellar-soroban.md](docs/research/stellar-soroban.md): Stellar accounts/transactions, SEP-5 derivation, Soroban simulation and auth entries, wallet interop SEPs

## Approach

- Derive ed25519 keys at `m/44'/148'/x'` via `snap_getBip32Entropy`: same addresses as Freighter/Ledger for the same mnemonic.
- Expose the five SEP-43 methods (`getAddress`, `signTransaction`, `signAuthEntry`, `signMessage`, `getNetwork`) with Freighter-compatible semantics.
- Simulate Soroban transactions in-snap before signing to show real resource fees, decoded invocations, and balance effects.
- Ship a connector npm package + Stellar Wallets Kit module so existing Stellar dapps get MetaMask support for free.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please see [SECURITY.md](SECURITY.md) for how to report security issues.

Audit reports are available in [audits/](audits/).

> **Disclaimer: use at your own risk.** We are committed to making this software as secure as possible through standards-compliant design, testing, and a planned third-party audit, but no software can be guaranteed free of vulnerabilities, and nothing here is a guarantee of security. It is provided "as is", without warranty of any kind, express or implied. You are solely responsible for reviewing the code and assessing its suitability before use. Interacting with blockchain networks carries inherent risk, including the irreversible loss of funds. The authors and contributors accept no liability for any loss or damage arising from its use.

### Snapper

The snap is scanned with [Snapper](https://github.com/sayfer-io/Snapper), the static-analysis tool named in MetaMask's Snaps allowlisting requirements. It runs as a manually-triggered GitHub Actions workflow:

1. Open the [**Snapper security scan** workflow](../../actions/workflows/snapper.yml) (Actions tab → "Snapper security scan").
2. Click **Run workflow**. It builds Snapper from source (Node 22) and scans `packages/snap`.
3. When the run finishes, open its summary page and download the **`snapper-report`** artifact (produced by the workflow's upload step). It contains `output.txt` with the scan log and findings.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

Copyright © 2026-present.
