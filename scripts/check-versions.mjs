/**
 * Asserts that every place carrying the release version agrees.
 *
 * The version is not stored once. It appears in both package manifests, in
 * the snap manifest that MetaMask validates, and as a hardcoded constant in
 * the connector that pins which snap version dapps install. A bump that
 * misses one of them is silent: the connector would keep requesting the
 * previous, differently-audited snap, and Directory allowlisting is
 * version-pinned, so the mismatch would ship.
 *
 * Throws (non-zero exit) on any disagreement. Run by CI and by the release
 * process; see docs/RELEASE.md.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Reads and parses a JSON file relative to the repository root.
 *
 * @param {string} relativePath - Path from the repository root.
 * @returns {Promise<any>} The parsed JSON.
 */
async function readJson(relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), 'utf8'));
}

const [snapPackage, connectorPackage, snapManifest, connectorSource] =
  await Promise.all([
    readJson('packages/snap/package.json'),
    readJson('packages/connector/package.json'),
    readJson('packages/snap/snap.manifest.json'),
    readFile(join(root, 'packages/connector/src/snap.ts'), 'utf8'),
  ]);

const pinMatch = connectorSource.match(/DEFAULT_SNAP_VERSION\s*=\s*'([^']+)'/u);

const sources = [
  ['packages/snap/package.json (version)', snapPackage.version],
  ['packages/snap/snap.manifest.json (version)', snapManifest.version],
  ['packages/connector/package.json (version)', connectorPackage.version],
  ['packages/connector/src/snap.ts (DEFAULT_SNAP_VERSION)', pinMatch?.[1]],
];

const missing = sources.filter(([, value]) => !value);
if (missing.length > 0) {
  throw new Error(
    `Could not read a version from:\n${missing
      .map(([label]) => `  - ${label}`)
      .join('\n')}`,
  );
}

const distinct = new Set(sources.map(([, value]) => value));
if (distinct.size > 1) {
  throw new Error(
    `Version mismatch across release-critical files:\n${sources
      .map(([label, value]) => `  ${value}  ${label}`)
      .join('\n')}\n\nAll four must match. ` +
      `See docs/RELEASE.md for the bump checklist.`,
  );
}

// The snap manifest must also point at the package the connector installs,
// or the pinned version would be pinned against the wrong package.
const manifestPackageName = snapManifest.source?.location?.npm?.packageName;
if (manifestPackageName !== snapPackage.name) {
  throw new Error(
    `Snap manifest packageName "${manifestPackageName}" does not match the ` +
      `published package name "${snapPackage.name}".`,
  );
}

console.log(
  `Version ${[...distinct][0]} is consistent across:\n${sources
    .map(([label]) => `  - ${label}`)
    .join('\n')}`,
);
