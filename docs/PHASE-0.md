# Phase 0 — Feasibility Spikes: Results

> Executed 2026-08-08. Plan reference: [PLAN.md](PLAN.md) Phase 0. Verdict: **all spikes green — proceed to Phase 1.**

## Summary

| Spike | Question | Result |
|---|---|---|
| Scaffold | Does the official template work here? | ✅ Monorepo scaffolded, builds, tests pass |
| A — SDK under SES | Does `@stellar/stellar-sdk` bundle & run in the snap sandbox? | ✅ Builds, passes `mm-snap eval`, executes at runtime; bundle 505 KB |
| B — SEP-5 derivation | Can we reproduce standard Stellar addresses from the MetaMask SRP? | ✅ **Exact match with official SEP-0005 test vectors** |
| C — CORS | Do Stellar endpoints accept snap fetches (`Origin: null`)? | ✅ All tested endpoints pass, including preflight |

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

| Endpoint | Simple ACAO | Preflight |
|---|---|---|
| horizon-testnet.stellar.org | `null` (echo) | 204, ACAO `null`, POST allowed |
| horizon.stellar.org (SDF mainnet) | `null` (echo) | — |
| soroban-testnet.stellar.org | `null` (echo) | 204, ACAO `*`, POST |
| soroban-rpc.mainnet.stellar.gateway.fm | `*` | 200, ACAO `*`, POST |
| rpc.ankr.com/stellar_soroban | `*` | 204, ACAO `*`, POST |
| stellar.api.onfinality.io/public | `*` | 200, ACAO `*`, POST |
| rpc.lightsail.network | `*` | 204, ACAO `*`, POST |
| friendbot.stellar.org | `*` (on 400 without addr) | — |

**No proxy needed** — every candidate endpoint, testnet and mainnet, is usable directly from the snap. (Re-verify the chosen mainnet provider's policy before launch; provider CORS policies can change.)

## Current snap surface (Phase 0 spike methods — will be replaced in Phase 1)

- `stellar_getAddress { index? }` → `{ address, index }` (SEP-5 derivation; no dialog yet)
- `stellar_sdkSmoke` → offline SDK exercise summary

Manifest permissions so far: `snap_dialog`, `endowment:rpc` (dapps), `snap_getBip32Entropy` (m/44'/148' ed25519).

## Outstanding before Phase 1 sign-off

- [ ] **Manual Flask check** (needs a browser with MetaMask Flask): install from `localhost:8080` (`yarn start`), call `stellar_getAddress`, confirm the permission prompt shows the Stellar path/curve correctly. The simulator gives high confidence, but a real-extension check is the true exit criterion.
- [ ] Add a snap icon (SVG) — build warns about it; required for directory listing later.
- [ ] Companion `packages/site` is still the stock template — Phase 1/3 will rework it.

## Audit note (timeline-critical)

`snap_getBip32Entropy` is an **audit-gated** permission: allowlisting for stable MetaMask requires a third-party audit (approved firms include Consensys Diligence, Cure53, Halborn, Least Authority, OtterSec, Sayfer, Veridise). Until audited + allowlisted, the snap runs only on MetaMask Flask. Engage an auditor early — see [PLAN.md](PLAN.md) Phase 5.
