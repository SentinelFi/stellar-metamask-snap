# Snapper scan disposition — 2026-08-11

|                    |                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tool**           | [Snapper](https://github.com/sayfer-io/Snapper) (Sayfer), built from `main` source via the [`Snapper security scan` workflow](../../.github/workflows/snapper.yml) |
| **Scanned commit** | `329c82f132bdde90a3dcf24157eb06fcd812bf78` (2026-08-10)                                                                                                            |
| **Scan date**      | 2026-08-11                                                                                                                                                         |
| **Scope**          | `packages/snap` (22 source files; test files skipped by the tool)                                                                                                  |
| **Raw report**     | [snapper-2026-08-11-329c82f.txt](snapper-2026-08-11-329c82f.txt)                                                                                                   |
| **Total findings** | 54                                                                                                                                                                 |
| **Real defects**   | **0** — every finding is a false positive or a conflict between Snapper's bundled lint config and MetaMask's own lint standard (details below)                     |

This was the second scan. The first scan (2026-08-10, report kept as a CI
artifact) surfaced real cleanups that were fixed in commits `12228a8`
(five findings fixed, `sdkSmoke.ts` diagnostic removed) and `329c82f`
(explicit return type on `safeFetch`). This re-run against the fixed commit
produced only the residual findings dispositioned here.

## Finding groups

### 1. `jsdoc` blank-line style — 42 findings — **won't fix (conflicts with MetaMask's own lint standard)**

`ESLinting: Expected only 0 line after block description` in
`keys/index.ts` (2), `rpc/errors.ts` (4), `rpc/router.ts` (1),
`rpc/validation.ts` (1), `state/index.ts` (8), `stellar/horizon.ts` (5),
`stellar/rpc.ts` (5), `stellar/safety.ts` (1), `stellar/soroban.ts` (7),
`stellar/token.ts` (4), `ui/format.ts` (4).

Snapper's bundled ESLint config wants **no** blank line between a JSDoc
block description and its first `@` tag. MetaMask's own
`@metamask/eslint-config` (which this repo extends) enforces the exact
opposite — `jsdoc/tag-lines: ['error', 'any', { startLines: 1 }]`
**requires one blank line** there. "Fixing" these would make `yarn lint`
fail against MetaMask's published standard. We follow the MetaMask config.

### 2. ESLint rule definitions not found — 4 findings — **false positive (scanner environment)**

`Definition for rule 'import-x/no-dynamic-require' was not found` (×2) and
`Definition for rule 'n/no-extraneous-require' was not found` (×2), all in
`snap.config.ts`.

These errors mean Snapper's ESLint environment does not load
`eslint-plugin-import-x` / `eslint-plugin-n`, so the
`eslint-disable` / `eslint-enable` comment pair at
`snap.config.ts` lines 7/13 references rules unknown _to Snapper_. In this
repo both plugins are loaded (via `@metamask/eslint-config`), the rules do
fire on the dynamic `require` there, and the directives are required for
`yarn lint` to pass. Not a code issue.

### 3. `HardcodedSecrets` — 6 findings — **false positive (not secrets)**

| File                      | Flagged string                       | What it actually is                    |
| ------------------------- | ------------------------------------ | -------------------------------------- |
| `stellar/horizon.ts` (×2) | `"application/json"`                 | HTTP `Accept`/`Content-Type` MIME type |
| `stellar/rpc.ts`          | `"application/json"`                 | HTTP MIME type                         |
| `stellar/safety.ts`       | `"pathPaymentStrictReceive"`         | Stellar operation type discriminant    |
| `stellar/soroban.ts`      | `"restoreFootprint"`                 | Soroban operation type discriminant    |
| `stellar/soroban.ts`      | `"hostFunctionTypeCreateContractV2"` | Soroban XDR host-function discriminant |

The detector pattern-matches string literals; none of these are
credentials, keys, or tokens. No secret material exists in the snap —
signing keys are derived on demand via `snap_getBip32Entropy` and never
serialized (see [docs/THREAT-MODEL.md](../../docs/THREAT-MODEL.md)).

### 4. Unused `eslint-disable` directive — 1 finding — **false positive (scanner environment)**

`rpc/router.ts`: `Unused eslint-disable directive (no problems were
reported from '@typescript-eslint/only-throw-error')`.

The directive (line 46) suppresses `@typescript-eslint/only-throw-error`
on `throw new MethodNotFoundError(...)` — a type-aware rule that cannot
see that `MethodNotFoundError` extends `Error`. In Snapper's environment
the type-aware rule doesn't fire, so the directive _looks_ unused there.
In this repo it is exercised; removing it breaks `yarn lint`.

### 5. `ExcessiveComments` — 1 finding — **false positive (documentation, not dead code)**

`snap.config.ts` lines 14–19: `Large section of commented-out code
detected`.

The flagged block is prose documentation explaining why the
`StripInsecureRandomnessPlugin` rewrites `Math.random` to
`crypto.getRandomValues` in the emitted bundle (bignumber.js ships
pre-minified inside `@stellar/stellar-sdk` and probes `Math.random` at
module init). It is security-relevant rationale, not disabled code, and
stays.

## Conclusion

All 54 findings reviewed; 0 required code changes. The scanned commit
stands as-is. Per [docs/research/snapper-security-scan.md](../../docs/research/snapper-security-scan.md),
Snapper should be re-run against the frozen pre-publish commit if the
snap source changes again before submission.
