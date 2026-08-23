/**
 * Refuses raw control and direction-altering characters in shipped source.
 *
 * Why this exists. A literal U+0000 spent time in `packages/snap/src/rpc/limiter.ts`,
 * written as the byte itself where the `\0` escape was meant. It changed no
 * behaviour, and that is the problem with it: GNU grep answers every search of
 * a file containing a NUL with "Binary file ... matches" instead of the
 * matching line, so the rate limiter, one of two in-memory abuse controls in
 * the snap, was the file a reviewer was least able to read with ordinary
 * tools. Nothing in lint, tests, or type checking notices, because nothing is
 * wrong with the program.
 *
 * The rest of the class is worse than inconvenient. A bidi override or a
 * zero-width joiner in source is the Trojan Source technique: the code a
 * reviewer reads and the code the compiler reads differ, deliberately. The
 * snap already refuses to *display* these characters without escaping them,
 * on the grounds that a reader must not be shown something other than what is
 * signed. The same argument applies to its own source and its reviewers.
 *
 * Escapes are unaffected. A string written as `'\u202E'` or `'\0'` is
 * ordinary ASCII on disk and passes; only the raw byte is refused. This asks
 * that the bytes be written the way they are meant to be read, which is the
 * rule this file has to follow itself, since it scans its own directory.
 *
 * Test files are exempt. Several carry these characters on purpose, as
 * fixtures for the sanitizer that strips them, and a fixture that had to be
 * escaped would no longer test the thing it exists to test.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories whose sources are checked. */
const ROOTS = [
  'packages/snap/src',
  'packages/connector/src',
  'packages/site/src',
  'scripts',
];

/** Extensions treated as source. */
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.jsx'];

/**
 * Characters refused in shipped source, by code point.
 *
 * C0 controls other than tab and newline; DEL; the bidi overrides and
 * isolates; the zero-width space, joiners, and no-break space; the byte-order
 * mark when it is not the first character; and the line and paragraph
 * separators.
 */
const FORBIDDEN = new RegExp(
  '[' +
    '\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F' + // C0 controls (tab and newline allowed) and DEL
    '\u00A0' + // no-break space
    '\u200B-\u200F' + // zero-width space, joiners, bidi marks
    '\u2028\u2029' + // line and paragraph separators
    '\u202A-\u202E' + // bidi embeddings and overrides
    '\u2060-\u2064' + // word joiner and invisible operators
    '\u2066-\u2069' + // bidi isolates
    '\uFEFF' + // byte-order mark
    ']',
  'u',
);

/**
 * Names the offending code point for the report.
 *
 * @param {string} character - The single offending character.
 * @returns {string} A `U+XXXX` label.
 */
function codePoint(character) {
  return `U+${character
    .codePointAt(0)
    .toString(16)
    .toUpperCase()
    .padStart(4, '0')}`;
}

/**
 * Every source file under a directory, recursively.
 *
 * @param {string} directory - Absolute directory to walk.
 * @returns {Promise<string[]>} Absolute file paths.
 */
async function sources(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return found;
    }
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sources(path)));
    } else if (
      entry.isFile() &&
      EXTENSIONS.some((extension) => entry.name.endsWith(extension)) &&
      // Fixtures for the sanitizer need the real characters.
      !/\.(?:test|spec)\./u.test(entry.name)
    ) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Reports every forbidden character in one file.
 *
 * @param {string} path - Absolute path to the file.
 * @returns {Promise<string[]>} One message per offending line.
 */
async function offences(path) {
  const text = await readFile(path, 'utf8');
  if (!FORBIDDEN.test(text)) {
    return [];
  }
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const character of line) {
      if (FORBIDDEN.test(character)) {
        found.push(
          `${relative(root, path).split(sep).join('/')}:${index + 1} contains ${codePoint(
            character,
          )} as a raw character; write it as an escape instead`,
        );
        return;
      }
    }
  });
  return found;
}

const files = (
  await Promise.all(ROOTS.map(async (dir) => sources(join(root, dir))))
).flat();
const found = (await Promise.all(files.map(offences))).flat();

if (found.length > 0) {
  throw new Error(
    `Raw control or direction-altering characters in source:\n${found.join('\n')}`,
  );
}

console.log(`No raw control characters in ${files.length} source files.`);
