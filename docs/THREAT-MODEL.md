# Threat Model — Stellar Soroban Snap

> Written 2026-08-10 for Phase 5 (pre-audit). Scope: `packages/snap` (the audited artifact) and its trust relationships. Companion artifacts (`packages/connector`, `packages/site`) run outside the snap sandbox and hold no secrets.

## 1. Assets

| Asset                                                                | Where it lives                                                                                                 | Exposure                                                                                      |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **SEP-0005 private key** (`m/44'/148'/x'`, ed25519)                  | Derived on demand from MetaMask's SRP via `snap_getBip32Entropy`; held only in function scope during a request | Never persisted, never returned via RPC, never sent over the network; no export method exists |
| **Signatures** (tx envelopes, Soroban auth entries, SEP-53 messages) | Produced in-request, returned to the calling dapp                                                              | Only after an explicit per-request user confirmation                                          |
| **Snap state** (`snap_manageState`, encrypted)                       | Active network, per-origin grants, tracked tokens                                                              | No key material; encrypted by MetaMask with a snap-specific key                               |
| **User's address**                                                   | Derivable on demand                                                                                            | Disclosed only to origins with a standing grant (or empty string)                             |

## 2. Trust boundaries & actors

```
[dapp origin]  --wallet_invokeSnap-->  [MetaMask]  --sandboxed-->  [snap (SES)]
                                                                     |  fetch
                                                     [Horizon / Stellar RPC endpoints]
```

- **Dapp (untrusted).** May send arbitrary method calls, malformed params, hostile XDR, and misleading claims about what a transaction does. Mitigations: superstruct validation on every method (§4.1); all display derived from parsed XDR, never dapp summaries (§4.2); per-origin grants; per-request confirmations; SEP-43 error sanitization (internal errors are replaced by a generic message so internals never leak).
- **MetaMask platform (trusted).** Supplies `origin` (the snap cannot verify it independently), the entropy API, dialogs, and state encryption. The SES sandbox and permission caveats (`m/44'/148'`/ed25519 only) are platform-enforced.
- **Network endpoints (semi-trusted, availability-untrusted).** Horizon and Stellar RPC responses drive _display aids only_: simulation results, safety warnings, balances. A malicious/compromised endpoint could suppress warnings or show wrong fees/balances — it can never alter what is signed, extract keys, or forge approval. Endpoint URLs are hardcoded per network (not dapp-supplied). See §5 residual risks.

## 3. Security claims (what an audit should try to break)

1. **No key exfiltration.** Private keys exist only inside `deriveKeypair` callers' scopes; there is no RPC method, log, state write, or network call that carries key material.
2. **Display integrity.** What the confirmation dialog shows is derived exclusively from the XDR that will be signed (`TransactionBuilder.fromXDR` / `xdr.SorobanAuthorizationEntry.fromXDR`). Unknown operation types render an explicit warning plus the raw XDR — never a silent skip. The snap never signs bare hashes: SEP-53 and Soroban auth preimages are reconstructed from parsed structures.
3. **No signature without consent.** Every signing path (`signTransaction`, `signAuthEntry`, `signMessage`) passes through `snap_dialog` and throws SEP-43 `-4` on rejection. `getAddress` is the only silent method and returns `''` without a grant.
4. **Network passphrase pinning.** Transactions/auth entries are parsed and signed against the active network's passphrase; a dapp-supplied mismatching passphrase is rejected (`-3`), preventing cross-network replay confusion.
5. **The snap never mutates what it signs.** Simulation and safety checks are read-only display aids; the signed bytes are exactly the dapp-provided XDR plus the appended signature.
6. **No insecure randomness.** `Math.random` is rewritten to `crypto.getRandomValues` at bundle time (webpack plugin in `snap.config.ts`); the shipped bundle contains zero `Math.random` occurrences. (Key derivation involves no local randomness at all — it is deterministic from the SRP.)

## 4. Mechanisms (code map for auditors)

| Concern                                                       | Module                                          |
| ------------------------------------------------------------- | ----------------------------------------------- |
| 4.1 Input validation (superstruct per method)                 | `src/rpc/validation.ts`                         |
| 4.2 XDR-only display, op whitelist, raw-XDR fallback          | `src/ui/transaction.tsx`                        |
| Key derivation (SLIP-10, index hardened, SEP-5-vector-tested) | `src/keys/index.ts`                             |
| Consent & origin grants                                       | `src/handlers/access.tsx`, `src/state/index.ts` |
| Signing paths                                                 | `src/handlers/sign.tsx`                         |
| Error sanitization (unknown → generic `-1`)                   | `src/rpc/router.ts`, `src/rpc/errors.ts`        |
| Soroban decode + display simulation                           | `src/stellar/soroban.ts`, `src/stellar/rpc.ts`  |
| Advisory safety checks (SEP-29, unfunded, multisig)           | `src/stellar/safety.ts`                         |
| Token metadata/balances via read-only simulation              | `src/stellar/token.ts`                          |
| Bundle-level randomness rewrite                               | `snap.config.ts`                                |

Test anchors: SEP-5 official vectors, cryptographic verification of every signature type against the derived public key, SEP-43 error codes, dialog-content assertions, persisted-state schema validation, contract-metadata bounds checking, and home-page consent interactions (132 snap tests across 9 suites, plus 10 connector tests).

## 5. Residual risks & accepted trade-offs

- **Display-aid trust in endpoints.** Simulation results, resource-fee estimates, and safety warnings are only as honest as the configured Horizon/RPC endpoints (SDF testnet; Gateway.fm mainnet). Failure mode is bounded: warnings are advisory, absence of a warning is never presented as "verified safe", and simulation failure renders an explicit "unavailable" banner.
- **`origin` string trust.** Origin gating relies on MetaMask's origin reporting; the snap cannot independently verify it. Platform-standard assumption for all snaps.
- **Multisig heuristic.** The insufficient-weight warning compares against the medium threshold only — not a per-operation threshold analysis. It can under- or over-warn; it never blocks.
- **Auto-grant on approved signature (deliberate).** Approving a signing dialog also records a connection grant for that origin. Our position: a signature approval is a strictly stronger act of consent than a connection approval, so deriving the weaker grant from the stronger one confers no authority the user has not already given, and the alternative (a second, redundant dialog immediately after the first) degrades consent quality by training users to click through. The dialog names the origin prominently, so the consent is informed. What the grant actually enables is narrow: silent `getAddress` for that origin, plus the `getBalances`/`fund`/`addToken` companion methods. It never enables signing, which always requires a fresh per-request confirmation. The address disclosed by a grant was already visible in the dialog the user just approved, so the marginal disclosure is nil. Grants are enumerable and revocable by the user at any time from the snap home page (Connected sites, then Disconnect), and revocation returns `getAddress` to `''`.
- **Cold signing surface (SEP-43 parity — deliberate).** `signTransaction`, `signAuthEntry`, `signMessage`, and `setNetwork` are callable by origins without a standing grant; the confirmation dialog itself is the consent (matching Freighter/SEP-43 semantics, where dapps may request a signature without a prior `requestAccess`). The residual exposure is dialog-fatigue phishing: a hostile site can summon signing dialogs cold. Mitigations: every dialog names the requesting origin prominently; nothing is signed or disclosed without approval; rejection returns `-4` with no state change; MetaMask serializes snap dialogs (no dialog storms). Gating signing on a prior grant was considered and rejected — it would break SEP-43-conformant dapps and add a second dialog without adding consent.
- **Entropy scope: the `m/44'/148'` subtree (deliberate).** The manifest requests the SLIP-10 subtree rather than the single account path `m/44'/148'/0'`, even though the RPC surface currently exposes only account index 0. Multi-account support is a committed roadmap decision (PLAN "support index param in API from day 1, UI for it later"; PHASE-1 "derivation supports it; API surface pins index 0 until account-management UX lands"): narrowing the caveat to `0'` would force a manifest permission change, a new shasum, and full user re-consent the moment a second account ships. The marginal exposure is bounded: the subtree covers only hardened Stellar accounts under coin type 148', no other coin type is reachable, and every use of the derived node stays inside `deriveKeypair`, which never persists or returns key material.
- **Truncated identifiers in dialogs (accepted).** The transaction source and simulation auth-signer rows truncate addresses (6+6 / 8+8 chars) for readability. Forging a vanity address matching 12–16 fixed base32 characters is computationally prohibitive, payment destinations are always shown in full via `Copyable`, and the complete raw XDR is present in every signing dialog.
- **Dependency surface.** Runtime dependencies are `@stellar/stellar-sdk` (XDR/crypto), `@metamask/key-tree` (SLIP-10), `@metamask/snaps-sdk`, and `@metamask/superstruct`. Supply-chain risk is mitigated by the audit pinning an exact commit plus lockfile, and by the manifest `shasum` sealing the exact published bundle.

  Known advisories from `yarn npm audit --environment production --recursive` run inside `packages/snap`: `form-data` (high), plus `axios`, `follow-redirects`, `lodash`, and `uuid` (moderate). Presence in the dependency graph is not the same as presence in the audited artifact, so each was checked against the built `dist/bundle.js`:

  | Package                                  | Via                                                                              | In the shipped bundle?                                                                                                                                |
  | ---------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `form-data`, `axios`, `follow-redirects` | `@stellar/stellar-sdk`                                                           | No. The snap hand-rolls its `fetch`-based Horizon/RPC client and never imports the SDK's Horizon or webauth modules, so webpack removes that subtree. |
  | `uuid`                                   | `@metamask/key-tree`, `@metamask/snaps-sdk`                                      | No.                                                                                                                                                   |
  | `lodash`                                 | `@metamask/utils` (transitive of `@metamask/key-tree` and `@metamask/snaps-sdk`) | **Yes.**                                                                                                                                              |

  Only `lodash` reaches the published bundle. Its advisory (prototype pollution via array-path bypass in `_.unset` and `_.omit`, GHSA-f23m-r3pf-42rh) is reached through MetaMask's own libraries: no snap code calls lodash, and nothing passes caller-controlled property paths to it, so exploitability appears low. It is nevertheless present in the artifact under audit and clears only when upstream `@metamask/key-tree` / `@metamask/snaps-sdk` ship a patched `@metamask/utils`.

  Reproduction note: a bare `yarn npm audit` at the repo root under-reports, because Yarn Berry defaults to the direct dependencies of the active workspace. Use `--recursive` for transitive dependencies, and run inside `packages/snap` (not `--all`) to exclude the Gatsby site's dev tooling, which dominates the monorepo-wide result and ships nothing.

## 6. Out of scope

- The MetaMask platform itself (SES, permission enforcement, state encryption) — report upstream.
- The Stellar protocol, SDK internals, and RPC/Horizon server implementations.
- The companion dapp and connector (no custody, no secrets; connector is a thin typed transport).
