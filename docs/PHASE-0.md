# Phase 0 — Feasibility Spikes: Results

> Executed 2026-08-08. Plan reference: [PLAN.md](PLAN.md) Phase 0. Verdict: **all spikes green — proceed to Phase 1.**

## Summary

| Spike                | Question                                                           | Result                                                               |
| -------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Scaffold             | Does the official template work here?                              | ✅ Monorepo scaffolded, builds, tests pass                           |
| A — SDK under SES    | Does `@stellar/stellar-sdk` bundle & run in the snap sandbox?      | ✅ Builds, passes `mm-snap eval`, executes at runtime; bundle 505 KB |
| B — SEP-5 derivation | Can we reproduce standard Stellar addresses from the MetaMask SRP? | ✅ **Exact match with official SEP-0005 test vectors**               |
| C — CORS             | Do Stellar endpoints accept snap fetches (`Origin: null`)?         | ✅ All tested endpoints pass, including preflight                    |

## Scaffold

- Template via `npm create @metamask/snap` (create-snap's own `yarn install` step failed on this machine; the cloned files were merged into the repo root and `yarn install` from the root succeeded — Yarn 1.22 delegates to the template-pinned Yarn 3.2.1 via `yarnPath`).
- Monorepo: `packages/snap` (the snap, renamed `stellar-soroban-snap`) + `packages/site` (Gatsby companion dapp, still template stock).
- Template's `.github` CI and duplicate license files were not copied; root license set to Apache-2.0 to match the repo's LICENSE.
- `platformVersion: 10.3.0`, `@metamask/snaps-sdk ~10.3.0`, `snaps-cli ^8.3.0`, `snaps-jest ^9.8.0`. Buffer polyfill already enabled in `snap.config.ts`.

## Spike A — `@stellar/stellar-sdk` under SES ✅

- Added `@stellar/stellar-sdk ^16.2.0` (stellar-base folded in) + `@metamask/key-tree`.
- [src/stellar/sdkSmoke.ts](../packages/snap/src/stellar/sdkSmoke.ts) exercises the signing-critical surface: `Keypair.fromRawEd25519Seed`, StrKey round-trip, `TransactionBuilder` payment tx with memo/timeout, `sign()`, signature verification against `tx.hash()`, XDR serialize → `TransactionBuilder.fromXDR` + `xdr.TransactionEnvelope.fromXDR` round-trip.
- **Build**: compiles; **`mm-snap eval` passes** (SES-compatible); snaps-jest executes it successfully in the simulator.
- **Bundle: 505,073 bytes (~493 KB)** with tree-shaking — no need for the `/base` subpath yet. Revisit when Horizon/rpc client imports are added in Phase 1 (importing `rpc.Server`/`Horizon.Server` will grow the bundle; measure then).
- ~~⚠️ Build warning: `Math.random` detected in bundle~~ **Resolved.** Traced to `bignumber.js`'s `BigNumber.random()` (shipped pre-minified inside stellar-sdk, so DefinePlugin couldn't reach it; it also probes `Math.random` once at module init, so a throwing stub crashed the bundle at load). Fixed with a custom webpack plugin in [snap.config.ts](../packages/snap/snap.config.ts) that rewrites the emitted bundle, backing every `Math.random` call with `crypto.getRandomValues` — secure randomness even if a future dependency uses it. Bundle now contains zero `Math.random` occurrences; build is warning-free.

## Spike B — SEP-0005 derivation ✅ (the core thesis, proven)

- [src/stellar/keys.ts](../packages/snap/src/stellar/keys.ts): `snap_getBip32Entropy` with manifest-pinned caveat `{path: ["m","44'","148'"], curve: "ed25519"}` → `SLIP10Node.fromJSON` → `derive(["slip10:{index}'"])` → `Keypair.fromRawEd25519Seed`.
- snaps-jest supports `installSnap({ options: { secretRecoveryPhrase } })`, so the tests install the snap with the **official SEP-0005 test vector mnemonic** (`illness spike retreat truth genius clock brain pass fit cave bargain toe`) and assert the spec's exact expected addresses:
  - index 0 → `GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6` ✅
  - index 1 → `GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX` ✅
- Conclusion: **the same mnemonic yields the same addresses as Freighter/Ledger/Lobstr (SEP-5 wallets)** — the differentiation vs the incumbent `stellar-snap` is real and working.
- All 4 tests pass (`yarn test`): 2 vector tests, SDK smoke, unknown-method error shape.

## Spike C — CORS with `Origin: null` ✅

Snap `fetch` runs in a sandboxed iframe ⇒ requests carry `Origin: null`. Probed with both simple requests and `OPTIONS` preflight (`Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: content-type`):

| Endpoint                               | Simple ACAO               | Preflight                      |
| -------------------------------------- | ------------------------- | ------------------------------ |
| horizon-testnet.stellar.org            | `null` (echo)             | 204, ACAO `null`, POST allowed |
| horizon.stellar.org (SDF mainnet)      | `null` (echo)             | —                              |
| soroban-testnet.stellar.org            | `null` (echo)             | 204, ACAO `*`, POST            |
| soroban-rpc.mainnet.stellar.gateway.fm | `*`                       | 200, ACAO `*`, POST            |
| rpc.ankr.com/stellar_soroban           | `*`                       | 204, ACAO `*`, POST            |
| stellar.api.onfinality.io/public       | `*`                       | 200, ACAO `*`, POST            |
| rpc.lightsail.network                  | `*`                       | 204, ACAO `*`, POST            |
| friendbot.stellar.org                  | `*` (on 400 without addr) | —                              |

**No proxy needed** — every candidate endpoint, testnet and mainnet, is usable directly from the snap. (Re-verify the chosen mainnet provider's policy before launch; provider CORS policies can change.)

## Current snap surface (Phase 0 spike methods — will be replaced in Phase 1)

- `stellar_getAddress { index? }` → `{ address, index }` (SEP-5 derivation; no dialog yet)
- `stellar_sdkSmoke` → offline SDK exercise summary

Manifest permissions so far: `snap_dialog`, `endowment:rpc` (dapps), `snap_getBip32Entropy` (m/44'/148' ed25519).

## Manual Flask verification (real extension)

Installed from `local:http://localhost:8080` into **MetaMask Flask on Brave** (separate browser profile, throwaway account). Install succeeded; the permission prompt displayed:

> - Manage **Unknown network** m/44'/148' (ed25519) accounts.
> - Display dialog windows in MetaMask.
> - Allow websites to communicate directly with Stellar Soroban.

The path, curve, and snap name render correctly. **Finding: MetaMask labels our chain "Unknown network"** rather than "Stellar" (analysis below).

`stellar_getAddress` against the real extension returned a well-formed account:

```json
{
  "address": "GCI7TJ7M62U6T3CAINS3NVONXSPJEGQINP6FR25JHXCC4WCH2HHVHU57",
  "index": 0
}
```

Validated with `StrKey`: 56 characters, valid ed25519 `G` strkey (CRC16 checksum passes), decodes to exactly 32 key bytes, and re-encodes identically. So the full chain — real MetaMask vault → `snap_getBip32Entropy` → SLIP-10 child derivation → `Keypair` → strkey encoding — works outside the simulator. (This wallet was created with a fresh random phrase, so the value differs from the SEP-5 test vector by design.)

`stellar_sdkSmoke` on the real extension returned all checks green:

```json
{
  "address": "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57",
  "strKeyRoundTrip": true,
  "signatureValid": true,
  "txHash": "97698040cea5eaa8fe3df6e3d8430a145967a5379e5d460f424daa5af7be110c",
  "xdrRoundTrip": true,
  "envelopeType": "envelopeTypeTx",
  "memo": "phase-0 spike"
}
```

That address derives from a **fixed** seed (`Buffer.alloc(32, 7)`) in the spike, so it is reproducible: computing it in plain Node yields the identical string. **Cryptographic operations under SES are therefore byte-identical to a standard environment** — ed25519 keypair derivation, tx-hash signing (network passphrase mixed in), signature verification, XDR serialize/parse fidelity, and memo preservation all confirmed on the real extension. Spike A is closed definitively.

### Why "Unknown network" — and how to fix it

Cause is in `@metamask/snaps-utils` [`derivation-paths.ts`](../node_modules/@metamask/snaps-utils/dist/derivation-paths.cjs):

1. `SNAPS_DERIVATION_PATHS` is a hardcoded list of recognized `(path, curve)` pairs — it includes Solana 501', Sui 784', NEAR 397', Aptos 637', Cardano, Tezos, IOTA… but has **no entry for 148' / ed25519**.
2. `getSnapDerivationPathName()` falls back to the SLIP-44 registry only `if (curve === 'secp256k1')`. Our curve is ed25519, so the fallback never runs — even though the registry does know the coin type:

```js
require('@metamask/slip44')['148'];
// => { index: '148', hex: '0x80000094', symbol: 'XLM', name: 'Stellar Lumens' }
```

**Fix: a one-entry upstream PR** to [MetaMask/snaps](https://github.com/MetaMask/snaps) (`packages/snaps-utils/src/derivation-paths.ts`) — the same way Sui, NEAR, and IOTA got their names listed:

```ts
{
  path: ['m', `44'`, `148'`],
  curve: 'ed25519',
  name: 'Stellar',
},
```

Cosmetic only — it does not affect derivation, security, or functionality — but it materially improves the trust signal on the install prompt, so it should be filed early enough to land before allowlisting. Tracked in [PLAN.md](PLAN.md).

## Outstanding before Phase 1 sign-off

- [ ] **Cross-wallet address confirmation.** Narrowly scoped now: the fixed-seed check above proves the SDK's crypto is identical under SES, and the automated tests prove SEP-5 vector conformance in the simulator. The single unverified link is whether **real MetaMask's `snap_getBip32Entropy` yields the same bytes as the simulator's** for a given mnemonic. Low risk (shared `key-tree` implementation), and closable either by restoring Flask with the published test mnemonic (expect `GDRXE2BQ…`) or importing the throwaway Flask phrase into Freighter and comparing.
- [x] ~~File the upstream `derivation-paths.ts` PR for the "Stellar" label~~ **Filed 2026-08-10: [MetaMask/snaps#4097](https://github.com/MetaMask/snaps/pull/4097)** (in review).
- [x] ~~Add a snap icon (SVG)~~ **Done** — [packages/snap/images/icon.svg](../packages/snap/images/icon.svg): the Stellar slashed-circle mark recreated as original vector art in a distinct gold-on-navy colorway (the press kit ships no SVG of the network mark), wired into the manifest `iconPath` and npm `files`.
- [ ] Companion `packages/site` is still the stock template — Phase 1/3 will rework it.

## Audit note (timeline-critical)

`snap_getBip32Entropy` is an **audit-gated** permission: allowlisting for stable MetaMask requires a third-party audit (approved firms include Consensys Diligence, Cure53, Halborn, Least Authority, OtterSec, Sayfer, Veridise). Until audited + allowlisted, the snap runs only on MetaMask Flask. Engage an auditor early — see [PLAN.md](PLAN.md) Phase 5.
