# Snapper scan disposition: 2026-08-27

|                    |                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tool**           | [Snapper](https://github.com/sayfer-io/Snapper) (Sayfer), built from `main` source via the [`Snapper security scan` workflow](../../.github/workflows/snapper.yml) |
| **Scanned commit** | `d346895a4c4afaab1e74535036dac5217b1d3382` (2026-08-25, tagged `pre-audit`)                                                                                        |
| **Scan date**      | 2026-08-27                                                                                                                                                        |
| **Scope**          | `packages/snap` (28 source files; test files skipped by the tool)                                                                                                 |
| **Raw report**     | [snapper-2026-08-27-d346895.txt](snapper-2026-08-27-d346895.txt)                                                                                                  |
| **Total findings** | 235                                                                                                                                                               |
| **Real defects**   | **0**: every finding is a false positive or a conflict between Snapper's bundled lint config and MetaMask's own lint standard (details below)                      |

This scan replaces the 2026-08-11 report (54 findings, all dispositioned as
false positives; that report and its disposition were removed when this one
landed, and remain in git history). The repo keeps exactly one current
Snapper report. Earlier history: the first scan (2026-08-10, kept as a CI
artifact) surfaced real cleanups fixed in commits `12228a8` and `329c82f`;
every scan since has produced only the residual finding classes below. The
finding count grew from 54 to 235 because the source grew (22 to 28 files)
through the audit-remediation passes, whose security-rationale comments and
suppression directives are exactly what these detectors misfire on.

All security-relevant detectors came back clean: 0 findings for
DangerousFunctions, InsecureRandomness, InsecureCryptography,
InsecureCryptoLibraries, ConsoleLog, LeftoverTODOs, UnusedFunctions,
UnusedImports, UnusedVariables, originValidation, BroadPermissions,
UnusedPermissions, DeprecatedPermissions, LackOfExceptionHandling,
FloatingPointPrecision, and ImproperTypeUsage.

## Finding groups

### 1. `jsdoc` blank-line style: 149 findings: **won't fix (conflicts with MetaMask's own lint standard)**

`ESLinting: Expected only 0 line after block description` in
`keys/index.ts` (28), `state/index.ts` (26), `stellar/soroban.ts` (24),
`ui/format.ts` (16), `stellar/events.ts` (9), `stellar/token.ts` (8),
`rpc/limiter.ts` (7), `stellar/horizon.ts` (6), `rpc/throttle.ts` (5),
`rpc/errors.ts` (4), `stellar/rpc.ts` (4), `rpc/validation.ts` (3),
`stellar/http.ts` (3), `stellar/safety.ts` (3), `rpc/router.ts` (2),
`stellar/ledger.ts` (1).

Snapper's bundled ESLint config wants **no** blank line between a JSDoc
block description and its first `@` tag. MetaMask's own
`@metamask/eslint-config` (which this repo extends) enforces the exact
opposite: `jsdoc/tag-lines: ['error', 'any', { startLines: 1 }]`
**requires one blank line** there. "Fixing" these would make `yarn lint`
fail against MetaMask's published standard. We follow the MetaMask config.

### 2. `ExcessiveComments` ("commented-out code"): 60 findings: **false positive (documentation, not dead code)**

Flagged ranges in `handlers/sign.tsx` (19), `keys/index.ts` (10),
`handlers/account.tsx` (4), `ui/transaction.tsx` (4), `handlers/home.tsx`
(3), `stellar/soroban.ts` (3), `stellar/safety.ts` (3), `ui/format.ts` (3),
`index.tsx` (2), `rpc/limiter.ts` (2), `state/index.ts` (2),
`snap.config.ts` (2), `handlers/access.tsx` (1), `handlers/network.tsx`
(1), `rpc/router.ts` (1).

The detector pattern-matches comment blocks that mention identifiers and
backticked code terms. Every flagged range is prose: the threat-model and
invariant rationale this codebase deliberately carries next to its
security-critical paths (why a ledger height is read from two sources and
the minimum wins, why grant recording is best effort, why the bundler
rewrites `Math.random`, and so on). None of it is disabled code, and it is
documentation an auditor needs; it stays.

### 3. `HardcodedSecrets`: 12 findings: **false positive (not secrets)**

| File                      | Flagged string                       | What it actually is                       |
| ------------------------- | ------------------------------------ | ----------------------------------------- |
| `stellar/horizon.ts` (×3) | `"application/json"`                 | HTTP `Accept`/`Content-Type` MIME type    |
| `stellar/rpc.ts`          | `"application/json"`                 | HTTP MIME type                            |
| `rpc/limiter.ts`          | `"setActiveAccount"`                 | RPC method name in the rate-limit table   |
| `rpc/throttle.ts`         | `"setActiveAccount"`                 | RPC method name in the throttle table     |
| `stellar/safety.ts`       | `"pathPaymentStrictReceive"`         | Stellar operation type discriminant       |
| `stellar/soroban.ts`      | `"restoreFootprint"`                 | Soroban operation type discriminant       |
| `stellar/soroban.ts`      | `"scvLedgerKeyContractInstance"`     | Soroban XDR ScVal discriminant            |
| `stellar/soroban.ts`      | `"hostFunctionTypeCreateContractV2"` | Soroban XDR host-function discriminant    |
| `stellar/soroban.ts` (×2) | `"assetTypeCreditAlphanum4"`         | Stellar XDR asset-type discriminant       |

The detector pattern-matches string literals; none of these are
credentials, keys, or tokens. No secret material exists in the snap:
signing keys are derived on demand via `snap_getBip32Entropy` and never
serialized (see [docs/THREAT-MODEL.md](../../docs/THREAT-MODEL.md)).

### 4. `UnhandledPromiseRejection` ("empty or ineffective catch block"): 6 findings: **false positive (deliberate best-effort handlers)**

One each in `index.tsx`, `stellar/http.ts`, `stellar/soroban.ts`,
`ui/transaction.tsx`, and two in `keys/index.ts`.

Each flagged catch is a comment-only (or fallback-only) block that is
intentional and individually documented in place, following the invariant
established in the internal audit passes: best-effort cleanup and
notification must never replace or mask the primary outcome they accompany
(for example `keys/index.ts`: "Never let best-effort cleanup replace the
refusal it accompanies"; `index.tsx`: "Nothing to report: the interaction's
own outcome was already shown"). Security-relevant failures in these paths
fail closed elsewhere; these catches exist precisely so that bookkeeping
failures cannot take signing or refusal paths down with them.

### 5. Unused `eslint-disable` directive: 4 findings: **false positive (scanner environment)**

`rpc/router.ts` (`@typescript-eslint/only-throw-error`),
`stellar/safety.ts` and `stellar/soroban.ts`
(`@typescript-eslint/switch-exhaustiveness-check`), `ui/format.ts`
(`no-misleading-character-class`).

Snapper's ESLint environment runs without this repo's type-aware lint
setup, so type-checked rules never fire there and the directives that
suppress them look unused. Under the repo's real config all four files lint
clean with `--report-unused-disable-directives` (verified 2026-08-27), and
removing the directives breaks `yarn lint`.

### 6. ESLint rule definitions not found: 4 findings: **false positive (scanner environment)**

`Definition for rule 'import-x/no-dynamic-require' was not found` (×2) and
`Definition for rule 'n/no-extraneous-require' was not found` (×2), all in
`snap.config.ts`.

Snapper's ESLint environment does not load `eslint-plugin-import-x` /
`eslint-plugin-n`, so the `eslint-disable` / `eslint-enable` comment pair
in `snap.config.ts` references rules unknown _to Snapper_. In this repo
both plugins are loaded (via `@metamask/eslint-config`), the rules do fire
on the dynamic `require` there, and the directives are required for
`yarn lint` to pass. Not a code issue.

## Conclusion

All 235 findings reviewed; 0 required code changes. The scanned commit
(`pre-audit` tag) stands as-is. Per
[docs/research/snapper-security-scan.md](../../docs/research/snapper-security-scan.md),
Snapper is re-run against the frozen pre-publish commit if the snap source
changes again before submission, and this report pair is replaced with that
run's output.
