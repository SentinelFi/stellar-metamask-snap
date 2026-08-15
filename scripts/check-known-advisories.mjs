/**
 * Gates the snap's TRANSITIVE production dependency graph against a reviewed
 * allowlist, and verifies the allowlist's central claim against the artifact.
 *
 * Why this exists. CI's other dependency gate runs
 * `yarn npm audit --all --environment production`, without `--recursive`.
 * Yarn Berry then audits only the DIRECT dependencies of the selected
 * workspaces. The snap's four direct runtime dependencies carry no advisories,
 * so that gate passes unconditionally and says nothing about the rest of the
 * graph, which is where every production advisory actually lives.
 *
 * The control the project relied on instead was a hand-written table in
 * docs/THREAT-MODEL.md recording which vulnerable packages reach the built
 * bundle. That analysis was correct, but it was a point-in-time human process
 * with nothing re-running it, and it had already drifted: advisories present in
 * the graph were missing from the table.
 *
 * A second trap is worth naming here, because it is what made the drift hard to
 * see. `yarn npm audit` WITHOUT `--json` prints roughly one row per package,
 * not one per advisory. Reading that output suggests a handful of issues when
 * the JSON reports dozens. This script reads the JSON.
 *
 * Usage:
 *   node scripts/check-known-advisories.mjs <audit.json>
 *
 * Exits non-zero when a vulnerable module is not on the allowlist, or when a
 * module the allowlist claims is absent from the bundle turns out to be in it.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = 'audits/known-advisories.json';
const BUNDLE = 'packages/snap/dist/bundle.js';

const [auditPath] = process.argv.slice(2);
if (!auditPath) {
  throw new Error(
    'Usage: node scripts/check-known-advisories.mjs <audit.json>\n' +
      'Produce the input with:\n' +
      '  yarn workspace stellar-soroban-snap exec -- \\\n' +
      '    yarn npm audit --environment production --recursive --json',
  );
}

const [auditRaw, allowlist, bundle] = await Promise.all([
  readFile(auditPath, 'utf8'),
  readFile(join(root, ALLOWLIST), 'utf8').then(JSON.parse),
  readFile(join(root, BUNDLE), 'utf8'),
]);

/*
 * `yarn npm audit --json` emits one JSON object, but a failed or empty run can
 * emit nothing at all. Treat an unparseable body as a failure rather than as
 * "no advisories": silently passing when the audit did not run is the one
 * outcome this script must never produce.
 */
let audit;
try {
  audit = JSON.parse(auditRaw);
} catch {
  throw new Error(
    `Could not parse the audit report at ${auditPath}. The audit likely did ` +
      `not run. Refusing to report a clean result from an absent report.`,
  );
}

/** Advisory count and highest severity per module. */
const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const found = new Map();
for (const advisory of Object.values(audit.advisories ?? {})) {
  const name = advisory.module_name;
  const entry = found.get(name) ?? { count: 0, severity: 'info', ids: [] };
  entry.count += 1;
  if ((RANK[advisory.severity] ?? 0) > (RANK[entry.severity] ?? 0)) {
    entry.severity = advisory.severity;
  }
  if (entry.ids.length < 3) {
    entry.ids.push(advisory.url ?? String(advisory.id));
  }
  found.set(name, entry);
}

const allowed = allowlist.modules ?? {};
const failures = [];

// 1. Every vulnerable module must have been reviewed.
for (const [name, entry] of found) {
  if (!Object.prototype.hasOwnProperty.call(allowed, name)) {
    failures.push(
      `UNREVIEWED  ${name} (${entry.count} advisory/advisories, highest: ` +
        `${entry.severity})\n` +
        `            ${entry.ids.join('\n            ')}\n` +
        `            Determine whether it reaches packages/snap/dist/bundle.js, ` +
        `then add an entry to ${ALLOWLIST} recording the finding, or clear the ` +
        `advisory with a resolution in the root package.json.`,
    );
  }
}

// 2. Every "absent from the bundle" claim must actually hold. This is the
//    check that keeps the allowlist honest as dependencies and bundling
//    behaviour change underneath it.
for (const [name, entry] of Object.entries(allowed)) {
  if (entry.absentFromBundle && bundle.includes(name)) {
    failures.push(
      `CLAIM BROKEN  ${ALLOWLIST} states "${name}" is absent from the bundle, ` +
        `but it appears in ${BUNDLE}.\n` +
        `              The advisory disposition rests on that absence, so it no ` +
        `longer holds. Either restore the tree-shaking that kept it out, or ` +
        `re-assess the advisory against code that now ships and record the ` +
        `result as an \`inBundle\` entry.`,
    );
  }
}

// 3. A module that genuinely ships must carry a written justification. This
//    arm exists so `inBundle` can never be used as a quiet escape hatch.
for (const [name, entry] of Object.entries(allowed)) {
  if (entry.inBundle && !entry.reason) {
    failures.push(
      `UNJUSTIFIED  ${ALLOWLIST} marks "${name}" as shipping in the bundle ` +
        `without a \`reason\`. A vulnerable package that reaches the signing ` +
        `artifact needs its exploitability argued in writing.`,
    );
  }
}

if (failures.length > 0) {
  throw new Error(`\n\n${failures.join('\n\n')}\n`);
}

const total = [...found.values()].reduce((sum, entry) => sum + entry.count, 0);
const shipping = Object.entries(allowed)
  .filter(([, entry]) => entry.inBundle)
  .map(([name]) => name);
const verifiedAbsent = Object.entries(allowed)
  .filter(([, entry]) => entry.absentFromBundle)
  .map(([name]) => name);
const perModule = [...found]
  .map(
    ([name, entry]) => `  ${name}: ${entry.count} (highest: ${entry.severity})`,
  )
  .join('\n');

process.stdout.write(
  `Transitive production advisories: ${total} across ${found.size} module(s), all reviewed in ${ALLOWLIST}.\n` +
    `${perModule}\n\n` +
    `Verified absent from ${BUNDLE}: ${verifiedAbsent.join(', ') || 'none'}\n` +
    `Vulnerable packages shipping in the bundle: ${shipping.join(', ') || 'none'}\n`,
);
