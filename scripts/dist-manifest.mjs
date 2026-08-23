/**
 * Writes, or checks, the committed digest manifest for a package's build
 * output.
 *
 * Why this exists. A release has to be able to say that the JavaScript it
 * publishes is a faithful compilation of the source that was reviewed. A
 * digest a build job takes of its own output cannot say that: the compiler
 * has already run by then, so it proves only "these are the same bytes that
 * were later packed", never "these bytes correspond to the reviewed
 * TypeScript". A build-chain compromise that emits malicious JavaScript into
 * an expected file would be recorded, packed, and published faithfully, with
 * no Git mutation and no forged hash anywhere.
 *
 * The anchor therefore has to predate the compiler, which means it has to be
 * committed and reviewed. The snap already had one of these in the `shasum`
 * field of its manifest, and what makes it worth something is not the hash
 * itself but the cross-platform comparison it forces: the developer builds on
 * one operating system and commits the result, CI rebuilds on another and
 * fails unless the committed value still matches. A tampered toolchain on
 * either side would have to produce exactly the other side's bytes to go
 * unnoticed. This gives the connector the same property, and gives the snap a
 * second one that can be checked without its build tooling.
 *
 * The output is deliberately in `sha256sum` format, with paths relative to
 * the package directory. That is the whole point of the format choice: the
 * release workflow verifies the packed archives in a job that has installed
 * nothing from this repository, and `sha256sum -c dist.sha256` needs only
 * coreutils. A verifier that had to run this script would be a verifier that
 * had to trust the dependency graph it exists to check.
 *
 * `sha256sum -c` answers for every file the manifest lists and says nothing
 * about a file it does not, so callers must compare the inventory too. This
 * script does when it checks, and the workflow does again against the
 * archive.
 *
 * Usage:
 *   node scripts/dist-manifest.mjs <package-dir>            # write
 *   node scripts/dist-manifest.mjs <package-dir> --check    # verify
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';

/** The build-output directory, relative to the package. */
const DIST = 'dist';

/** The manifest file, relative to the package. */
const MANIFEST = 'dist.sha256';

/**
 * Every file under a directory, recursively.
 *
 * @param {string} root - The directory to walk.
 * @returns {Promise<string[]>} Absolute paths, in no particular order.
 */
async function walk(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(path)));
    } else if (entry.isFile()) {
      found.push(path);
    } else {
      // A symlink or device node is never something a compiler emitted, and
      // each is a way to make a hashed tree differ from the tree that is read.
      throw new Error(`${path} is not a regular file or directory`);
    }
  }
  return found;
}

/**
 * Computes the manifest text for a package's build output.
 *
 * Sorted by path, byte for byte, so the file a developer commits does not
 * depend on the order the filesystem happened to return.
 *
 * @param {string} packageDir - The package directory.
 * @returns {Promise<string>} The manifest text, ending in a newline.
 */
async function manifestFor(packageDir) {
  const distDir = resolve(packageDir, DIST);
  let files;
  try {
    files = await walk(distDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`${distDir} does not exist; build the package first`);
    }
    throw error;
  }
  if (files.length === 0) {
    // An empty manifest would make every later comparison pass while proving
    // nothing at all.
    throw new Error(`${distDir} contains no files`);
  }
  const entries = await Promise.all(
    files.map(async (file) => ({
      path: posix.join(DIST, relative(distDir, file).split(sep).join('/')),
      digest: createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    })),
  );
  return `${entries
    .sort((left, right) => (left.path < right.path ? -1 : 1))
    // Two spaces: the separator `sha256sum` writes and `sha256sum -c` reads.
    .map((entry) => `${entry.digest}  ${entry.path}`)
    .join('\n')}\n`;
}

/**
 * Reports the lines that differ between the committed and computed manifests.
 *
 * @param {string} committed - The committed manifest text.
 * @param {string} computed - The manifest text just computed.
 * @returns {string} A description of the differences, one line each.
 */
function describeDrift(committed, computed) {
  const committedLines = new Set(committed.split('\n').filter(Boolean));
  const computedLines = new Set(computed.split('\n').filter(Boolean));
  return [
    ...[...committedLines]
      .filter((line) => !computedLines.has(line))
      .map((line) => `  committed: ${line}`),
    ...[...computedLines]
      .filter((line) => !committedLines.has(line))
      .map((line) => `  built:     ${line}`),
  ].join('\n');
}

/**
 * Writes or checks one package's manifest.
 *
 * @returns {Promise<void>} Resolves when the manifest is written or verified.
 */
async function main() {
  const [packageDir, mode] = process.argv.slice(2);
  if (!packageDir) {
    throw new Error(
      'Usage: node scripts/dist-manifest.mjs <package-dir> [--check]',
    );
  }

  const manifestPath = resolve(packageDir, MANIFEST);
  const computed = await manifestFor(packageDir);

  if (mode !== '--check') {
    await writeFile(manifestPath, computed);
    const count = computed.trimEnd().split('\n').length;
    console.log(`Wrote ${MANIFEST} (${count} files).`);
    return;
  }

  let committed;
  try {
    committed = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `${MANIFEST} is missing. Build the package to write it, and commit it.`,
    );
  }
  if (committed !== computed) {
    throw new Error(
      `${manifestPath} does not describe the build output on disk.\n` +
        'Either the output changed without the manifest being regenerated ' +
        '(build the package and commit it), or the same source has just ' +
        'produced different bytes, which is what this check exists to ' +
        `surface.\n${describeDrift(committed, computed)}`,
    );
  }
  console.log(`${MANIFEST} matches the build output.`);
}

await main();
