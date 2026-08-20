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

See the [threat model](https://github.com/SentinelFi/stellar-metamask-snap/blob/main/docs/THREAT-MODEL.md) and [SECURITY.md](https://github.com/SentinelFi/stellar-metamask-snap/blob/main/SECURITY.md) for reporting.

### Supported operations

The snap **refuses to sign what it cannot show you in full**. Rather than fall back to a warning over raw XDR, which is not a review anyone can perform, `signTransaction` rejects the request before any dialog opens when a transaction contains an operation type it has no renderer for. The same rule applies to undecodable host functions, contract-call arguments too large or deeply nested to display, embedded authorization entries it cannot render, and Soroban footprints that are missing or cannot be shown in full.

That makes the supported set a hard compatibility boundary, so it is stated here rather than discovered at signing time:

| Supported today                                                                                                                                                                                                                                                                                               | Not yet supported (signing is refused)                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `payment`, `createAccount`, `changeTrust`, `pathPaymentStrictSend`, `pathPaymentStrictReceive`, `manageData`, `setOptions`, `accountMerge`, `manageBuyOffer`, `manageSellOffer`, `createPassiveSellOffer`, `createClaimableBalance`, `claimClaimableBalance`, `liquidityPoolDeposit`, `liquidityPoolWithdraw` | `clawback`, `clawbackClaimableBalance`, `setTrustLineFlags`, `allowTrust`, `bumpSequence`, `beginSponsoringFutureReserves`, `endSponsoringFutureReserves`, `revokeSponsorship` |
| `invokeHostFunction`, `extendFootprintTtl`, `restoreFootprint`                                                                                                                                                                                                                                                |                                                                                                                                                                                |

In practice this means payments, trustlines, account setup and recovery, DEX offers, liquidity pools, claimable balances, and the full Soroban surface work today, while clawback, trustline-flag, and sponsorship flows do not. Offer prices are shown as the exact ratio the network stores alongside a decimal reading, and claimable-balance conditions are spelled out in words; a claim condition the snap cannot render in full is refused like any other undisplayable value. A refused request returns SEP-43 error `-3` and names the offending operation types, so an integrator can detect it precisely. Renderers for the remaining set are planned; the fail-closed rule itself is not up for relaxation.

## For dapp developers

Use the companion package [`stellar-soroban-snap-connector`](https://www.npmjs.com/package/stellar-soroban-snap-connector): a typed SEP-43 client, a drop-in `@stellar/freighter-api` facade, and a Stellar Wallets Kit module.

```ts
import { StellarSnap } from 'stellar-soroban-snap-connector';

const snap = new StellarSnap();
const { address } = await snap.connect();
const { signedTxXdr } = await snap.signTransaction(xdr);
```

## Repository

Source, documentation, and companion dapp: [github.com/SentinelFi/stellar-metamask-snap](https://github.com/SentinelFi/stellar-metamask-snap) (Apache-2.0).
