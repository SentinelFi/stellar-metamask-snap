/**
 * Gates the snap's exact, lockfile-resolved production dependency graph against
 * the npm advisory database and the reviewed allowlist.
 *
 * Why this exists alongside `yarn npm audit`. The vendored Yarn 3 audit builds
 * its dependency map keyed by package NAME across every workspace in the
 * monorepo, so when two workspaces resolve different versions of the same
 * package, one arbitrary version wins and is reported as if it were the snap's.
 * Measured on this repository: the snap resolves `axios@1.18.0` (through
 * `@stellar/stellar-sdk`) while the site resolves `axios@1.12.1` (through
 * gatsby), and `yarn npm audit` run from packages/snap reports the advisories of
 * 1.12.1 with a path through the stellar SDK. Today that over-reports; the same
 * mechanism would silently UNDER-report the day the roles reverse, which is the
 * failure mode a gate must never have. `scripts/check-known-advisories.mjs`
 * still consumes that audit and still proves, through bundle markers, that the
 * packages it allowlists are absent from the shipped artifact. This script is
 * the version-accurate first layer in front of it.
 *
 * How the graph is computed. `yarn info --recursive --virtuals --json`, run in
 * packages/snap, prints Yarn's own resolution of the workspace: one NDJSON line
 * per locator with the exact locator of each dependency edge, including the
 * peer dependencies Yarn resolved for each virtual instance. This script starts
 * at the workspace's manifest `dependencies` (its `devDependencies` are
 * deliberately not followed: they build and test the snap but never ship) and
 * walks the edges to a fixed point. The result is the closure a lockfile-aware
 * scanner would compute, obtained from the same data Yarn installs from, with
 * no dependency on the audit code path.
 *
 * How advisories are fetched. The exact `{ name: [versions] }` map is posted to
 * the npm registry's bulk advisory endpoint, which answers only with advisories
 * whose vulnerable range contains one of the versions given. Before any empty
 * answer is believed, the endpoint is asked about a version known to carry an
 * advisory and must answer non-empty; if it does not, the query technique has
 * stopped working and the run fails rather than reporting clean.
 *
 * Usage:
 *   node scripts/check-snap-graph-advisories.mjs [graph.ndjson]
 *
 * Without an argument the graph is produced by running the vendored Yarn. With
 * an argument, that file is read instead (useful for archiving the graph of a
 * release build, or for running the judgement offline against a saved graph).
 *
 * Exits non-zero when the graph cannot be computed, when the registry cannot
 * be reached or answers unexpectedly, when the canary query returns nothing,
 * or when any advisory lands in a module that `audits/known-advisories.json`
 * has not dispositioned.
 */

/* eslint-disable n/no-process-env */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_DIR = 'packages/snap';
const ALLOWLIST = 'audits/known-advisories.json';
const BULK_ADVISORY_URL =
  'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

/**
 * A package version that certainly carries a published advisory (lodash
 * 4.17.20: prototype pollution via `zipObjectDeep`, fixed in 4.17.21). The
 * registry must report at least one advisory for it, or the bulk endpoint's
 * semantics have changed under this script and an empty answer for the real
 * graph proves nothing.
 */
const CANARY = { lodash: ['4.17.20'] };

/**
 * Parses a Yarn locator into its name and reference.
 *
 * @param {string} locator - A locator such as `@scope/name@npm:1.2.3`.
 * @returns {{ name: string, reference: string }} The split locator.
 */
function splitLocator(locator) {
  const at = locator.indexOf('@', locator.startsWith('@') ? 1 : 0);
  if (at === -1) {
    throw new Error(`Unparseable locator: ${locator}`);
  }
  return { name: locator.slice(0, at), reference: locator.slice(at + 1) };
}

/**
 * Strips a `virtual:<hash>#` prefix so a virtual instance maps back to the
 * concrete package it is an instance of.
 *
 * @param {string} locator - A possibly virtual locator.
 * @returns {string} The devirtualized locator.
 */
function devirtualize(locator) {
  const { name, reference } = splitLocator(locator);
  if (!reference.startsWith('virtual:')) {
    return locator;
  }
  const hashEnd = reference.indexOf('#');
  if (hashEnd === -1) {
    throw new Error(`Virtual locator without a base reference: ${locator}`);
  }
  return `${name}@${reference.slice(hashEnd + 1)}`;
}

/**
 * Extracts the installed version from a concrete (non-virtual) locator. Only
 * registry packages (`npm:`) and Yarn-patched registry packages (`patch:`)
 * are expected in the snap's production graph; anything else is a shape this
 * script does not know how to audit and is reported as such.
 *
 * @param {string} locator - A devirtualized locator.
 * @returns {{ name: string, version: string }} Name and version.
 */
function locatorToVersion(locator) {
  const { name, reference } = splitLocator(locator);
  if (reference.startsWith('npm:')) {
    return { name, version: reference.slice('npm:'.length) };
  }
  if (reference.startsWith('patch:')) {
    // patch:<inner-locator>#<patch-path>::version=<version>&hash=<hash>
    const versionMatch = reference.match(/::version=([^&]+)/u);
    if (versionMatch?.[1]) {
      return { name, version: decodeURIComponent(versionMatch[1]) };
    }
    const inner = decodeURIComponent(
      reference.slice('patch:'.length).split('#')[0] ?? '',
    );
    return locatorToVersion(inner);
  }
  throw new Error(
    `Locator ${locator} is neither a registry package nor a patched one. ` +
      `The snap's production graph should contain nothing else; inspect ` +
      `how it got there before extending this script to accept it.`,
  );
}

/**
 * Finds the vendored Yarn binary named by .yarnrc.yml, so the graph is
 * produced by the exact Yarn this repository installs with.
 *
 * @returns {Promise<string>} Absolute path to the Yarn release file.
 */
async function vendoredYarnPath() {
  const rc = await readFile(join(root, '.yarnrc.yml'), 'utf8');
  const match = rc.match(/^yarnPath:\s*(\S+)\s*$/mu);
  if (!match?.[1]) {
    throw new Error('Could not find `yarnPath` in .yarnrc.yml.');
  }
  return join(root, match[1]);
}

/**
 * Produces the NDJSON graph of the snap workspace by asking Yarn directly.
 *
 * @returns {Promise<string>} The NDJSON output of `yarn info`.
 */
async function produceGraph() {
  const yarnPath = await vendoredYarnPath();
  const { stdout } = await execFileAsync(
    process.execPath,
    [yarnPath, 'info', '--recursive', '--virtuals', '--json'],
    {
      cwd: join(root, WORKSPACE_DIR),
      maxBuffer: 64 * 1024 * 1024,
      // `yarn info` reads the installed project state; it must never decide
      // to talk to the network or mutate anything while doing so.
      env: { ...process.env, YARN_ENABLE_NETWORK: '0' },
    },
  );
  return stdout;
}

/**
 * Parses `yarn info --json` output into a map from locator to its record.
 *
 * @param {string} ndjson - Newline-delimited JSON as printed by `yarn info`.
 * @returns {Map<string, any>} Locator to `children` record.
 */
function parseGraph(ndjson) {
  const entries = new Map();
  for (const line of ndjson.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const record = JSON.parse(line);
    if (typeof record.value !== 'string' || !record.children) {
      throw new Error(`Unexpected \`yarn info\` record: ${line.slice(0, 200)}`);
    }
    entries.set(record.value, record.children);
  }
  return entries;
}

/**
 * Walks from the workspace's production dependencies to the full closure.
 *
 * @param {Map<string, any>} entries - Parsed graph.
 * @param {string} workspaceLocator - The snap workspace's locator.
 * @param {Set<string>} productionNames - Names listed under `dependencies`
 * (and `optionalDependencies`) in the workspace manifest.
 * @returns {Map<string, Set<string>>} Package name to the set of versions
 * reachable from the production entry points.
 */
function productionClosure(entries, workspaceLocator, productionNames) {
  const workspace = entries.get(workspaceLocator);
  if (!workspace) {
    throw new Error(
      `The graph contains no record for ${workspaceLocator}; was \`yarn info\` ` +
        `run from ${WORKSPACE_DIR}?`,
    );
  }

  const roots = (workspace.Dependencies ?? []).filter((edge) =>
    productionNames.has(splitLocator(edge.locator).name),
  );
  const rootNames = new Set(
    roots.map((edge) => splitLocator(edge.locator).name),
  );
  const missing = [...productionNames].filter((name) => !rootNames.has(name));
  if (missing.length > 0) {
    throw new Error(
      `The workspace manifest lists production dependencies that the graph ` +
        `does not resolve: ${missing.join(', ')}. The install is stale or the ` +
        `graph was produced for a different checkout.`,
    );
  }

  const visited = new Set();
  const queue = roots.map((edge) => edge.locator);
  while (queue.length > 0) {
    const locator = queue.shift();
    if (visited.has(locator)) {
      continue;
    }
    visited.add(locator);

    // A virtual instance carries the peer dependencies Yarn resolved for it;
    // its regular dependencies live on the concrete package it instantiates.
    // Follow both so peer-provided packages are part of the closure exactly as
    // Yarn linked them.
    const concrete = devirtualize(locator);
    const records = [entries.get(locator)];
    if (concrete !== locator) {
      records.push(entries.get(concrete));
    }
    if (records.every((record) => !record)) {
      throw new Error(
        `Edge to ${locator} has no record in the graph. \`yarn info\` output ` +
          `is incomplete; refusing to audit a partial closure.`,
      );
    }
    for (const record of records) {
      for (const edge of record?.Dependencies ?? []) {
        queue.push(edge.locator);
      }
      for (const edge of record?.['Peer dependencies'] ?? []) {
        // A null locator is an unmet optional peer: nothing was installed
        // for it, so there is nothing to audit.
        if (edge.locator) {
          queue.push(edge.locator);
        }
      }
    }
  }

  const closure = new Map();
  for (const locator of visited) {
    const { name, version } = locatorToVersion(devirtualize(locator));
    const versions = closure.get(name) ?? new Set();
    versions.add(version);
    closure.set(name, versions);
  }
  return closure;
}

/**
 * Posts a `{ name: [versions] }` map to the npm bulk advisory endpoint.
 *
 * @param {Record<string, string[]>} body - Packages to query.
 * @returns {Promise<Record<string, any[]>>} Advisories keyed by package name.
 */
async function queryAdvisories(body) {
  const response = await fetch(BULK_ADVISORY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(
      `The advisory endpoint answered ${response.status} ${response.statusText}. ` +
        `Refusing to report a clean result from a failed query.`,
    );
  }
  const result = await response.json();
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(
      `The advisory endpoint returned an unexpected body shape ` +
        `(${Array.isArray(result) ? 'array' : typeof result}).`,
    );
  }
  return result;
}

const [graphPath] = process.argv.slice(2);

const [ndjson, workspaceManifest, allowlist] = await Promise.all([
  graphPath ? readFile(graphPath, 'utf8') : produceGraph(),
  readFile(join(root, WORKSPACE_DIR, 'package.json'), 'utf8').then(JSON.parse),
  readFile(join(root, ALLOWLIST), 'utf8').then(JSON.parse),
]);

const entries = parseGraph(ndjson);
const workspaceLocator = `${workspaceManifest.name}@workspace:${WORKSPACE_DIR}`;
const productionNames = new Set([
  ...Object.keys(workspaceManifest.dependencies ?? {}),
  ...Object.keys(workspaceManifest.optionalDependencies ?? {}),
]);
if (productionNames.size === 0) {
  throw new Error(
    `${WORKSPACE_DIR}/package.json declares no production dependencies, which ` +
      `cannot be right for a snap that bundles the Stellar SDK.`,
  );
}

const closure = productionClosure(entries, workspaceLocator, productionNames);
const query = Object.fromEntries(
  [...closure].map(([name, versions]) => [name, [...versions].sort()]),
);
const packageCount = Object.values(query).reduce(
  (sum, versions) => sum + versions.length,
  0,
);

// Prove the endpoint still answers with advisories before believing an empty
// answer about the real graph. Asked in a separate request so the canary can
// never be confused with the snap's own lodash.
const canaryAnswer = await queryAdvisories(CANARY);
const canaryHits = Object.values(canaryAnswer).flat().length;
if (canaryHits === 0) {
  throw new Error(
    `CANARY FAILED  the advisory endpoint reported no advisories for ` +
      `${JSON.stringify(CANARY)}, which certainly has at least one. The bulk ` +
      `query no longer works the way this script assumes, so an empty result ` +
      `for the snap's graph would prove nothing. Refusing to report clean.`,
  );
}

const answer = await queryAdvisories(query);

/** Advisory count and highest severity per module. */
const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const found = new Map();
for (const [name, advisories] of Object.entries(answer)) {
  if (!Array.isArray(advisories) || advisories.length === 0) {
    continue;
  }
  const entry = { count: 0, severity: 'info', ids: [] };
  for (const advisory of advisories) {
    entry.count += 1;
    if ((RANK[advisory.severity] ?? 0) > (RANK[entry.severity] ?? 0)) {
      entry.severity = advisory.severity;
    }
    if (entry.ids.length < 3) {
      entry.ids.push(advisory.url ?? String(advisory.id));
    }
  }
  found.set(name, entry);
}

const allowed = allowlist.modules ?? {};
const failures = [];
for (const [name, entry] of found) {
  const versions = query[name]?.join(', ') ?? '?';
  if (!Object.prototype.hasOwnProperty.call(allowed, name)) {
    failures.push(
      `UNREVIEWED  ${name}@${versions} (${entry.count} advisory/advisories, ` +
        `highest: ${entry.severity})\n` +
        `            ${entry.ids.join('\n            ')}\n` +
        `            This version is what the snap's lockfile-resolved ` +
        `production graph actually contains. Determine whether the package ` +
        `reaches packages/snap/dist/bundle.js, then add an entry to ` +
        `${ALLOWLIST} recording the finding, or clear the advisory with a ` +
        `resolution in the root package.json.`,
    );
    continue;
  }
  if (allowed[name].inBundle && !allowed[name].reason) {
    failures.push(
      `UNJUSTIFIED  ${ALLOWLIST} marks "${name}" as shipping in the bundle ` +
        `without a \`reason\`, and ${name}@${versions} carries ` +
        `${entry.count} advisory/advisories.`,
    );
  }
}

if (failures.length > 0) {
  throw new Error(`\n\n${failures.join('\n\n')}\n`);
}

const total = [...found.values()].reduce((sum, entry) => sum + entry.count, 0);
const perModule = [...found]
  .map(
    ([name, entry]) =>
      `  ${name}@${query[name].join(', ')}: ${entry.count} (highest: ${entry.severity})`,
  )
  .join('\n');
const graphListing = Object.entries(query)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, versions]) => `  ${name}@${versions.join(', ')}`)
  .join('\n');

process.stdout.write(
  `Snap production graph: ${packageCount} package version(s) across ` +
    `${closure.size} package(s), resolved from ${
      graphPath ?? 'yarn info --recursive --virtuals'
    }.\n` +
    `Advisory endpoint canary: ${canaryHits} advisory/advisories for ` +
    `${JSON.stringify(CANARY)} (query technique confirmed live).\n` +
    `Advisories in the snap's exact production graph: ${total} across ` +
    `${found.size} module(s)${
      found.size > 0 ? `, all reviewed in ${ALLOWLIST}:\n${perModule}` : '.'
    }\n\n` +
    `Graph audited:\n${graphListing}\n`,
);
