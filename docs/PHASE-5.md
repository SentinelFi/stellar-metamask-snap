# Phase 5 — Audit & Distribution: Preparation Notes

> Prepared 2026-08-10. Plan reference: [PLAN.md](PLAN.md) Phase 5. Predecessors: Phases 0–4.
> Status: **preparation complete — the remaining steps are external** (audit engagement, npm publish, directory submission) and listed in the checklist at the bottom.

Unlike Phases 0–4, this phase is mostly process: the code is feature-complete and verified (109 snap + 10 connector tests, CI green). What follows is what was prepared, the decisions taken, and exactly what remains to do outside this repository.

## Hardening sweep (done)

- **`console` logs:** zero across `packages/snap/src` and `packages/connector/src`; the two template `console.error` calls in the companion dapp were removed for uniformity.
- **TODO/FIXME/XXX/HACK comments:** zero across all packages.
- **Unused permissions:** none — every manifest permission maps to live code:

| Permission                                   | Used by                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `snap_dialog`                                | every consent flow (`handlers/*`)                                                  |
| `snap_manageState`                           | `state/index.ts` (network, grants, tokens)                                         |
| `endowment:rpc` (dapps, maxRequestTime 180s) | `onRpcRequest` router                                                              |
| `endowment:network-access`                   | Horizon (`stellar/horizon.ts`), Stellar RPC (`stellar/rpc.ts`, `stellar/token.ts`) |
| `endowment:page-home`                        | `onHomePage` (`handlers/home.tsx`)                                                 |
| `endowment:lifecycle-hooks`                  | `onInstall` (`handlers/install.tsx`)                                               |
| `snap_getBip32Entropy` (m/44'/148', ed25519) | `keys/index.ts`                                                                    |

- No dead code: the Phase 0 diagnostic `sdkSmoke.ts` was removed from the source tree (preserved in the `phase-0`/`phase-1` tags).

## Threat model (done)

[THREAT-MODEL.md](THREAT-MODEL.md) — assets, trust boundaries, the six security claims an auditor should attack (no key exfiltration, display integrity, consent on every signature, passphrase pinning, sign-exactly-what-was-given, no insecure randomness), a code map per concern, and residual risks.

## npm publish readiness (done — publish itself is a user action)

- Both packages have `README.md` + `LICENSE` (Apache-2.0) and correct metadata (`author`, `repository`, `publishConfig.access: public`).
- **Pack contents verified** via `yarn workspace <name> pack --dry-run`:
  - `stellar-soroban-snap` → `dist/bundle.js`, `images/icon.svg`, `snap.manifest.json`, LICENSE, README, package.json — exactly the files the manifest references.
  - `stellar-soroban-snap-connector` → complete `dist/` with type declarations, LICENSE, README, package.json.
- Versions aligned (`0.1.0` in both `package.json`s and the snap manifest); `prepublishOnly: mm-snap manifest` regenerates the shasum at publish time; CI's manifest-drift check guards it between releases.
- **Name check before first publish:** confirm `stellar-soroban-snap` and `stellar-soroban-snap-connector` are still free on npm at publish time; if taken, the fallback is scoping under the npm account (requires updating `snap.manifest.json` `packageName`, connector `DEFAULT_SNAP_ID`, and docs).

## Build reproducibility (verified; Node 22 only)

The Directory review and any auditor check that the published bundle matches the `shasum` in `snap.manifest.json`, so the build has to be reproducible rather than assumed to be.

**Verified on Node 22.17.1 (2026-08-13):** building twice in place, and building from a fresh `git clone` with `yarn install --immutable`, both produce a byte-identical `packages/snap/dist/bundle.js` (`sha256 490c5358…`) and therefore an identical manifest shasum.

**Supported build runtime is Node 22 only.** `engines.node` is `^22.0.0` in the root, snap, and site packages, and `.nvmrc` pins `22`, matching the CI workflows. Reasons:

- Node 20 reached end of life in April 2026, so declaring support for it means declaring support for an unsupported runtime.
- The repository previously declared three different things (`^20.0.0 || >=22.0.0` in the root and snap, `>=18.6.0` in the site, `lts/*` in `.nvmrc`, which drifts as new LTS lines ship). There was no single answer to "what builds this", which is exactly the ambiguity a shasum check punishes.
- Narrowing to one line removes the cross-version question rather than answering it: a reviewer building on the declared runtime gets the bytes we published.

The connector deliberately keeps no `engines` constraint: it is a library that dapp developers consume on whatever runtime they use, and restricting it would warn them without improving the reproducibility of the audited artifact.

If the supported line ever moves (say Node 22 approaching its own end of life in April 2027), re-run the two checks above on the new line before changing `engines`, and re-verify the shasum.

## Mainnet RPC decision (taken)

**Default Soroban RPC for PUBLIC stays `https://soroban-rpc.mainnet.stellar.gateway.fm`; Horizon stays `https://horizon.stellar.org`.** Rationale: both verified to accept `Origin: null` (snap sandbox) including preflight in Phase 0's CORS spike; Gateway.fm is keyless and SDF-listed. Risks and mitigations: provider CORS/policy can change → **re-run the Phase 0 CORS probe against mainnet endpoints immediately before submission and after any provider incident**; Ankr/OnFinality/Lightsail all passed the same probe and are drop-in replacements (one constant in `state/networks.ts`). A user-configurable custom-network/RPC override remains a tracked post-launch feature.

## Snapper scan (assessed; run via the CI workflow on the frozen commit)

Assessment and how-to: [research/snapper-security-scan.md](research/snapper-security-scan.md). Both Snapper's npm release and its Docker image are currently broken, so the [`Snapper security scan` workflow](../.github/workflows/snapper.yml) builds it from source (Node 22) and scans `packages/snap` — run it manually (Actions tab) on the frozen pre-publish commit, review the artifact, and commit the report to [`audits/scans/`](../audits/scans/) for the submission.

## Directory submission draft

For the [Snaps Directory Information form](https://docs.metamask.io/snaps/how-to/get-allowlisted):

- **Snap name:** Stellar Soroban
- **npm:** `stellar-soroban-snap` (version-pinned; every release needs re-submission)
- **Category:** Interoperability
- **One-line description:** Stellar and Soroban in MetaMask — SEP-0005 accounts, transaction review with in-snap simulation, and the standard Stellar wallet API for dapps.
- **Longer description:** derive from the snap README (SEP-5 derivation compatible with Freighter/Ledger, SEP-43 dapp API, decoded confirmation dialogs with Soroban simulation, safety warnings, token tracking, home page).
- **Repository:** https://github.com/SentinelFi/stellar-metamask-snap
- **Audit report:** attach when available (required — entropy permission).
- **Support contact:** GitHub issues + the SECURITY.md private-reporting channel.
- **To produce at submission time:** screenshots (install prompt, transaction review dialog incl. Soroban simulation, home page) and a short demo video (connect → fund → sign payment → sign Soroban invoke).

## Remaining external steps (user actions, in order)

1. **Track [MetaMask/snaps#4097](https://github.com/MetaMask/snaps/pull/4097)** — the "Stellar" derivation-path label should land before allowlisting review.
2. **Engage a third-party auditor** — mandatory (audit-gated `snap_getBip32Entropy`). Candidates from the approved list (verify current MetaMask wiki): OtterSec, Cure53, Halborn, Least Authority, Sayfer, Veridise. Provide: pinned commit hash, [THREAT-MODEL.md](THREAT-MODEL.md), scope = `packages/snap` + key-management path. Expect weeks of lead time; fixes → re-verify → pin the final audited commit.
3. **Freeze the release commit** (after audit fixes): re-run the mainnet CORS probe; run the **Snapper scan** (CI workflow) on it; tag it.
4. **npm publish** both packages from that commit (`npm login` as the owning account; `yarn workspace stellar-soroban-snap npm publish` and same for the connector — or `npm publish` from each package dir). Verify the npm pages render.
5. **Submit the Directory Information form** with the audit report, screenshots, and demo video; respond to the ≥2-approval review.
6. **After allowlisting:** file the Stellar Wallets Kit upstream PR (module referencing the now-live `npm:stellar-soroban-snap`), announce, and switch the companion dapp's production env (`.env.production`) to the npm snap ID.

## Post-launch parking lot

i18n string catalog; SEP-7/SEP-10 helpers; `snap_notify`; guided restore-then-retry; custom networks; multi-account UI; NFT/vault display (SEP-50/56 — see PLAN).
