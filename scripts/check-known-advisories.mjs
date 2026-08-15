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
 * A third trap, and the reason this script's bundle check looks the way it
 * does. The obvious way to verify "this package does not ship" is to search the
 * bundle for the package name, which is what this script did originally. That
 * check has no power: `mm-snap build` emits a minified bundle in which package
 * names do not survive. On the 0.1.0 bundle the strings `stellar-base` and
 * `@noble` are both absent while both packages demonstrably ship, so a zero-hit
 * result proved nothing and would have kept passing on the day a dependency
 * bump pulled axios in. The check now searches for `bundleMarkers`, string
 * literals from each package's runtime code, and it first proves it can find
 * anything at all by requiring the allowlist's `positiveControls` (markers from
 * packages that certainly do ship) to be present. A missing positive control
 * means the technique itself has stopped working, which is reported as a
 * failure rather than as a clean run.
 *
 * Usage:
 *   node scripts/check-known-advisories.mjs <audit.json>
 *
 * Exits non-zero when a vulnerable module is not on the allowlist, when a
 * module the allowlist claims is absent from the bundle turns out to be in it,
 * or when the bundle search can no longer be shown to work.
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

// 2. The bundle search must be shown to work before any absence result from it
//    is believed. Minification strips package names and can strip or rewrite
//    other text too, so a search that finds nothing is only evidence when the
//    same search reliably finds things that are certainly there.
const positiveControls = allowlist.positiveControls ?? [];
if (positiveControls.length === 0) {
  failures.push(
    `NO POSITIVE CONTROL  ${ALLOWLIST} defines no \`positiveControls\`, so the ` +
      `absence checks below cannot be shown to have any power.\n` +
      `                     Add at least one marker from a package that ` +
      `certainly ships (key derivation or stellar-base are the obvious ones).`,
  );
}
for (const control of positiveControls) {
  if (!bundle.includes(control.marker)) {
    failures.push(
      `CONTROL LOST  the positive control "${control.marker}" (from ` +
        `${control.from}) is NOT present in ${BUNDLE}.\n` +
        `              That package certainly ships, so the bundle search has ` +
        `stopped working: minification, bundling, or the dependency itself has ` +
        `changed. Every "absent from the bundle" result below is therefore ` +
        `unproven, and this script refuses to report them as clean.\n` +
        `              Re-derive the markers against the current bundle before ` +
        `trusting any advisory disposition that rests on them.`,
    );
  }
}

// 3. Every "absent from the bundle" claim must actually hold, checked through
//    markers rather than the package name. This is what keeps the allowlist
//    honest as dependencies and bundling behaviour change underneath it.
for (const [name, entry] of Object.entries(allowed)) {
  if (!entry.absentFromBundle) {
    continue;
  }
  const markers = entry.bundleMarkers ?? [];
  if (markers.length === 0) {
    failures.push(
      `NO MARKERS  ${ALLOWLIST} claims "${name}" is absent from the bundle but ` +
        `gives no \`bundleMarkers\` to check it with.\n` +
        `            An unverifiable absence claim is the thing this script ` +
        `exists to prevent. Add string literals from the package's runtime ` +
        `code (error messages, header names, protocol constants); identifiers ` +
        `and file paths do not survive minification.`,
    );
    continue;
  }
  const present = markers.filter((marker) => bundle.includes(marker));
  if (present.length > 0) {
    failures.push(
      `CLAIM BROKEN  ${ALLOWLIST} states "${name}" is absent from the bundle, ` +
        `but ${present.length} of its markers appear in ${BUNDLE}:\n` +
        `${present.map((marker) => `                "${marker}"`).join('\n')}\n` +
        `              The advisory disposition rests on that absence, so it no ` +
        `longer holds. Either restore the tree-shaking that kept it out, or ` +
        `re-assess the advisory against code that now ships and record the ` +
        `result as an \`inBundle\` entry.`,
    );
  }
}

// 4. A module that genuinely ships must carry a written justification. This
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
  .map(([name, entry]) => `${name} (${entry.bundleMarkers.length} markers)`);
const perModule = [...found]
  .map(
    ([name, entry]) => `  ${name}: ${entry.count} (highest: ${entry.severity})`,
  )
  .join('\n');

process.stdout.write(
  `Transitive production advisories: ${total} across ${found.size} module(s), all reviewed in ${ALLOWLIST}.\n` +
    `${perModule}\n\n` +
    `Bundle search proven live by ${positiveControls.length} positive control(s): ` +
    `${positiveControls.map((control) => control.from).join(', ')}\n` +
    `Verified absent from ${BUNDLE}: ${verifiedAbsent.join(', ') || 'none'}\n` +
    `Vulnerable packages shipping in the bundle: ${shipping.join(', ') || 'none'}\n`,
);
