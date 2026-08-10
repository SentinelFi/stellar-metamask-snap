# Phase 1 — Core Snap MVP: Implementation Notes

> Built 2026-08-10. Plan reference: [PLAN.md](PLAN.md) Phase 1. Predecessor: [PHASE-0.md](PHASE-0.md).
> Status: **complete** — SEP-43 RPC surface, per-operation confirmation dialogs, origin grants, network state, Horizon client; 19/19 tests green, lint clean, SES eval passing.

## What shipped

The Phase 0 spike methods (`stellar_getAddress`, `stellar_sdkSmoke`) were replaced by the real wallet API. Method names are unprefixed (the snap ID already namespaces them) and follow SEP-0043 shapes with Freighter-compatible semantics.

### RPC surface

| Method              | Params                                           | Returns                                     | Consent                                                                |
| ------------------- | ------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| `requestAccess`     | —                                                | `{ address }`                               | Connect dialog on first use; silent once granted                       |
| `getAddress`        | —                                                | `{ address }` (empty string if not granted) | None — silent by design (Freighter semantics; prevents fingerprinting) |
| `getNetwork`        | —                                                | `{ network, networkPassphrase }`            | None (non-identifying)                                                 |
| `getNetworkDetails` | —                                                | `+ networkUrl, sorobanRpcUrl`               | None                                                                   |
| `setNetwork`        | `{ network: 'PUBLIC'\|'TESTNET'\|'FUTURENET' }`  | network details                             | Confirmation dialog (mainnet warning banner)                           |
| `signTransaction`   | `{ xdr, networkPassphrase?, address?, submit? }` | `{ signedTxXdr, signerAddress, hash? }`     | Full transaction-review dialog                                         |
| `signMessage`       | `{ message, address? }`                          | `{ signedMessage (base64), signerAddress }` | SEP-53 dialog                                                          |
| `fund`              | `{ address? }`                                   | `{ funded, address }`                       | Requires prior grant; test networks only                               |
| `getBalances`       | `{ address? }`                                   | `{ address, funded, sequence, balances[] }` | Requires prior grant                                                   |

Error model: every failure is a `SnapError` whose `data.code` carries the SEP-43 code — `-1` internal (generic message; internals never leak), `-2` external service, `-3` invalid request, `-4` user rejected (message string identical to Freighter's `"The user rejected this request."`). The Phase 3 connector maps these 1:1.

### Consent model

- **Origin grants** persist in state; `requestAccess` is the explicit grant path.
- **An approved signature is also consent**: `signTransaction`/`signMessage` don't require a prior grant (the dialog shows the origin and is itself the consent act), and approval records the grant so `getAddress` works afterwards.
- `fund`/`getBalances` (network-touching, wallet-account-oriented) require a standing grant.
- `getAddress` without a grant returns `{ address: '' }` silently — no dialog spam, no fingerprinting.

### Transaction review dialog ([ui/transaction.tsx](../packages/snap/src/ui/transaction.tsx))

- Content derives **only from the parsed XDR** — dapp-provided summaries are never trusted.
- Network banner (info for test networks, warning for PUBLIC), source, max fee (stroops → XLM), sequence, memo (typed).
- Decoded per-operation sections: `payment`, `createAccount`, `changeTrust` (trustline-removal flagged), `pathPaymentStrictSend/Receive`, `manageData`, `setOptions` (warning banner; signer/master-weight rows marked critical), `accountMerge` (danger banner: irreversible).
- **Unknown operation types render an explicit warning** — never silently skipped — with the raw XDR `Copyable` at the bottom as the source of truth (XRPL-snap whitelist pattern).
- **Sequence-0 transactions are framed as SEP-10 authentication** ("cannot be submitted, does not move funds") instead of a transfer review.
- Fee-bump envelopes show the fee source, new max fee, and the decoded inner transaction.
- `networkPassphrase` param mismatching the active network → `-3` error telling the dapp to `setNetwork` (deliberately stricter than Freighter's warn-and-sign).

### Architecture

```
packages/snap/src/
  index.tsx            entry — onRpcRequest → route()
  rpc/router.ts        method table, unknown-method rejection, error sanitization
  rpc/errors.ts        SEP-43 error factories (SnapError + data.code)
  rpc/validation.ts    @metamask/superstruct schemas → -3 on mismatch
  keys/index.ts        SEP-5 derivation m/44'/148'/x' (never persisted)
  state/index.ts       versioned state: { version, network, origins } (encrypted)
  state/networks.ts    PUBLIC / TESTNET / FUTURENET endpoints + passphrases
  stellar/horizon.ts   account summary, tx submit, friendbot (fetch)
  ui/dialogs.tsx       Connect / NetworkSwitch / SignMessage dialogs
  ui/transaction.tsx   transaction review + per-operation renderers
  ui/format.ts         stroops→XLM, asset/memo/address formatting
  stellar/sdkSmoke.ts  Phase 0 reference (unwired; excluded from bundle)
```

Manifest additions: `snap_manageState`, `endowment:network-access`, `endowment:rpc.maxRequestTime: 180000` (users get up to 3 minutes to review a signing dialog).

## Testing (19 tests, [index.test.tsx](../packages/snap/src/index.test.tsx))

- SEP-5 vector conformance through the real `requestAccess`/`getAddress` flow (official mnemonic → exact expected address).
- Transaction signature cryptographically verified against the SEP-5 public key; SEP-53 signature verified over the reconstructed prefix hash.
- Every SEP-43 error code asserted via `error.data.code`; rejection message string matched.
- Dialog-content assertions: connect dialog, mainnet warning, SEP-10 framing, undecoded-op warning, accountMerge danger.
- Grant lifecycle: silence before grant, persistence after, auto-grant after approved signature, `fund`/`getBalances` gating, friendbot-on-PUBLIC refusal.

### Test-infrastructure notes (hard-won)

- stellar-sdk v16 depends on ESM-only `@noble/*` packages that Jest's CJS runtime can't load and ts-jest won't transform (its `allowJs` passthrough ignores node_modules JS in this setup). Solution: `moduleNameMapper` in [jest.config.js](../packages/snap/jest.config.js) maps `@noble/hashes/sha2.js` and `@noble/ed25519` to tiny node:crypto-backed CJS shims ([test/shims/](../packages/snap/test/shims/)), and maps the SDK root to its CJS `base` build (tests only use base primitives). **The snap bundle itself uses the real noble implementations** — shims affect the Jest module space only.
- The snaps-sdk JSX factory returns `unknown` (validated at runtime), so helper functions that produce dialog children are typed `GenericSnapElement`, and top-level dialog builders `JSXElement`.

## Companion dapp ([packages/site](../packages/site))

Phase 1 test bench: request access, silent getAddress, network details/switch, friendbot fund, balances, **sign payment** (builds a real 1.5 XLM self-payment with the live sequence via `getBalances`), sign message. Gatsby needed a `Buffer` polyfill ([gatsby-node.js](../packages/site/gatsby-node.js)) for `@stellar/stellar-sdk/base`.

## Manual test drive

```bash
yarn start
```

Then in the Flask browser profile: open http://localhost:8000 → Connect (approve the updated permissions — the snap now also asks for network access and storage) → Request access → Fund → Balances → Sign payment / Sign message.

> Re-installing over the Phase 0 snap triggers the update-permissions prompt; approve it or remove and reinstall.

## Deferred (tracked in [PLAN.md](PLAN.md))

- Soroban depth (Phase 2): `invokeHostFunction` simulation-driven review, `signAuthEntry`, token balances, restore preamble.
- Connector package + Stellar Wallets Kit module (Phase 3).
- `submit: true` exists but is best-effort (Horizon sync submit; no polling); revisit with Phase 2 RPC client.
- Multi-account (`m/44'/148'/x'`, x > 0): derivation supports it; API surface pins index 0 until account-management UX lands.
- `isConnected`/`setAllowed`/`WatchWalletChanges` Freighter-parity helpers: connector-side concerns (Phase 3).
