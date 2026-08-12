# Stellar Soroban Snap

A MetaMask Snap that brings the **Stellar network** — including **Soroban smart contracts** — to MetaMask.

> Independent software, not affiliated with or endorsed by the Stellar Development Foundation.

## What it does

- Derives your Stellar account from the MetaMask Secret Recovery Phrase using **SEP-0005** (`m/44'/148'/x'`, ed25519) — the same standard as Freighter, Ledger, and Lobstr, so the same phrase yields the same `G...` address everywhere. Conformance is enforced against the official SEP-0005 test vectors.
- Exposes the **SEP-0043** wallet API to dapps with Freighter-compatible semantics: `requestAccess`, `getAddress`, `getNetwork` / `getNetworkDetails`, `setNetwork`, `signTransaction`, `signAuthEntry`, `signMessage`, plus `fund` (test-network friendbot), `getBalances`, `addToken`, `getAccounts`, and `setActiveAccount`.
- Supports **multiple accounts**: add further SEP-0005 accounts (`m/44'/148'/1'`, `2'`, ...) from the snap home page and switch between them; dapps can target any added account per request via the SEP-43 `address` option, and every signing dialog names the account that signs.
- **Reviews before it signs**: every transaction is decoded from its XDR (never from dapp-provided summaries) into a human-readable confirmation dialog. Soroban transactions get an in-snap display-verification simulation (estimated resource fee, required auth signers, restore warnings); classic payments get advisory safety checks (unfunded destination, SEP-29 memo-required, multisig weight).
- Shows your address, network, and balances (XLM + tracked Soroban tokens) on the snap **home page**: MetaMask menu → Snaps → Stellar Soroban.

## Security model

- Private keys are derived on demand inside the MetaMask (SES) sandbox, are never persisted, and there is **no key-export method** of any kind.
- Every signature requires an explicit MetaMask confirmation; dapp origins need a user grant before reading your address.
- Networks: PUBLIC (mainnet), TESTNET (default), FUTURENET — with the network passphrase pinned into every signature.

See the [threat model](https://github.com/jeffnuclear/stelllar-metamask-snap/blob/main/docs/THREAT-MODEL.md) and [SECURITY.md](https://github.com/jeffnuclear/stelllar-metamask-snap/blob/main/SECURITY.md) for reporting.

## For dapp developers

Use the companion package [`stellar-soroban-snap-connector`](https://www.npmjs.com/package/stellar-soroban-snap-connector): a typed SEP-43 client, a drop-in `@stellar/freighter-api` facade, and a Stellar Wallets Kit module.

```ts
import { StellarSnap } from 'stellar-soroban-snap-connector';

const snap = new StellarSnap();
const { address } = await snap.connect();
const { signedTxXdr } = await snap.signTransaction(xdr);
```

## Repository

Source, documentation, and companion dapp: [github.com/jeffnuclear/stelllar-metamask-snap](https://github.com/jeffnuclear/stelllar-metamask-snap) (Apache-2.0).
