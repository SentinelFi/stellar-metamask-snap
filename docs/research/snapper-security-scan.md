# Snapper Security Scan — Assessment & How-To

> Reviewed 2026-08-10. Sources: [MetaMask allowlisting guide](https://docs.metamask.io/snaps/how-to/get-allowlisted), [sayfer-io/Snapper](https://github.com/sayfer-io/Snapper).
> For the Phase 5 (audit & distribution) checklist.

## What Snapper is

A static-analysis CLI (TypeScript / Node ≥ 22, by security firm Sayfer) that scans a MetaMask Snap's source for vulnerabilities, risky patterns, and best-practice violations. It is the tool **named by name** in MetaMask's allowlisting requirements:

> "Scan your Snap for security vulnerabilities using Snapper and resolve any reported issues."

## Should we use it? — Yes, in Phase 5

- **Recommended, not a hard gate.** The allowlisting page lists it as a prerequisite step but without strict "must" language (unlike the third-party audit, which _is_ mandatory for our entropy permissions). However, MetaMask's own reviewers use it, so a clean Snapper run materially de-risks the ≥2-approval review.
- **Low cost, complements the human audit.** It catches the mechanical issues (leftover `console` logs, `to-do` comments, unused permissions/methods — all separately required to be removed) before a paid auditor's time is spent on them.
- **When to run: once, against the frozen pre-publish / pre-audit commit** — not during active development (it would only churn). Re-run after any post-audit fixes.

## Allowlisting requirements it fits into

From [get-allowlisted](https://docs.metamask.io/snaps/how-to/get-allowlisted):

1. Publicly readable source code
2. Published to npm
3. Legal/regulatory compliance
4. **Clean code** — remove all `console` logs, `to-do` comments, unused permissions/methods
5. **Security scan** — run Snapper, resolve findings ← this doc
6. **Third-party audit** from an approved auditor — **mandatory for us** (we use `snap_getBip32Entropy`, an audit-gated permission)
7. Minimum two MetaMask approvals
8. Only needed because we use protected permissions (rpc/network-access/entropy); open permissions wouldn't require allowlisting

### Docker (recommended — avoids the npm packaging bug)

```bash
git clone https://github.com/sayfer-io/Snapper.git
cd Snapper
docker build -t snapper .
# scan our snap package (mount it read-only):
docker run --rm -v /abs/path/to/stelllar-metamask-snaps/packages/snap:/snap snapper --path /snap
```

### From source

```bash
git clone https://github.com/sayfer-io/Snapper.git
cd Snapper && npm install
node ./dist/index.js --path /abs/path/to/stelllar-metamask-snaps/packages/snap
```

### Useful flags

`--detectors` / `--ignoreDetectors` (select rules), `--htmlReport` (human-readable report to attach to the directory submission), `--logFile`, `--verbose`.

## Scope note

Scan **`packages/snap`** (the published snap). The connector and site are separate npm/dapp artifacts, not the allowlisted snap. Snapper's rule set list isn't published in the README; run with defaults first, then review the HTML report.

## Pre-emptive state (already clean)

- `console` logs: **none** in `packages/snap/src` (verified 2026-08-10).
- Unused permissions: manifest permissions are all exercised (`snap_dialog`, `snap_manageState`, `endowment:rpc`, `endowment:network-access`, `endowment:page-home`, `endowment:lifecycle-hooks`, `snap_getBip32Entropy`).
- `to-do` comments: none intended; re-grep before the scan.
