/**
 * Builds the published documentation site from the repository's markdown.
 *
 * The docs are written for the repository first: they are read on GitHub, in
 * pull requests, and by auditors reading the tree. This script publishes them
 * without forking them, so there is exactly one copy of every sentence and no
 * "the website says otherwise" failure mode.
 *
 * Deliberately small. A documentation generator would bring a dependency tree
 * larger than the snap itself into a repository whose whole argument is that
 * its supply chain is reviewable, to render a dozen markdown files. What is
 * here is a renderer (`marked`), a template, and a stylesheet.
 *
 * The output is static HTML with no JavaScript at all, which is what lets the
 * embedded Content-Security-Policy forbid script outright. GitHub Pages serves
 * no headers of its own, so the policy travels in a meta tag.
 *
 * Usage: `yarn build:docs` (output in `docs-site/`).
 */

import { marked } from 'marked';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs-site');
const REPO = 'https://github.com/SentinelFi/stellar-metamask-snap';
const BLOB = `${REPO}/blob/main`;

/**
 * The published set, in navigation order.
 *
 * Curated rather than "every file under docs/". The phase plans and the
 * research notes are working material: they record what was decided while it
 * was being decided, they are written to a future maintainer rather than to a
 * reader arriving cold, and publishing them would bury the four pages that
 * actually answer a visitor's question. They stay in the repository, where
 * anyone who wants them can read them in context.
 */
const PAGES = [
  {
    slug: 'index',
    title: 'Overview',
    source: 'README.md',
    summary: 'What the snap is, how to install it, and what it does.',
  },
  {
    slug: 'connector-api',
    title: 'Connector API',
    source: 'docs/CONNECTOR-API.md',
    summary: 'The typed SEP-0043 client dapps integrate against.',
  },
  {
    slug: 'threat-model',
    title: 'Threat model',
    source: 'docs/THREAT-MODEL.md',
    summary:
      'Assets, trust boundaries, mechanisms, and accepted residual risk.',
  },
  {
    slug: 'architecture',
    title: 'Architecture',
    source: 'docs/MENTAL-MAP.md',
    summary: 'How the pieces fit together, and why they are shaped this way.',
  },
  {
    slug: 'multi-account',
    title: 'Multiple accounts',
    source: 'docs/MULTI-ACCOUNT.md',
    summary: 'SEP-0005 account derivation, revealing, and switching.',
  },
  {
    slug: 'release',
    title: 'Release process',
    source: 'docs/RELEASE.md',
    summary: 'How a release is cut and what carries the version.',
  },
  {
    slug: 'changelog',
    title: 'Changelog',
    source: 'CHANGELOG.md',
    summary: 'What changed, and why.',
  },
];

/** Source paths that resolve to a published page, for link rewriting. */
const PUBLISHED = new Map(
  PAGES.map((page) => [
    page.source,
    page.slug === 'index' ? './' : `./${page.slug}.html`,
  ]),
);

/**
 * Escapes text for safe inclusion in HTML.
 *
 * @param {string} value - The raw text.
 * @returns {string} The escaped text.
 */
function escapeHtml(value) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/**
 * Turns heading text into a URL fragment.
 *
 * @param {string} text - The heading's rendered text.
 * @returns {string} The slug.
 */
function headingId(text) {
  return (
    text
      .replace(/<[^>]*>/gu, '')
      // The heading arrives already HTML-escaped, so an `&` in the source is
      // `&amp;` here. Dropping entities rather than slugifying them is what
      // keeps "Trust boundaries & actors" from becoming `...-amp-actors`.
      .replace(/&[a-z]+;/gu, ' ')
      .toLowerCase()
      .replace(/[^\w\s-]/gu, '')
      .trim()
      .replace(/\s+/gu, '-')
  );
}

/**
 * Rewrites a repository-relative link for the published site.
 *
 * Four cases, and getting them wrong is how a docs site ends up full of 404s.
 * A link to another published page becomes that page. A link to any other
 * file in the tree becomes a GitHub blob URL, because the file exists, just
 * not here. A link that climbs above the repository root is GitHub's own
 * idiom for "somewhere else on this repository" (`../../actions/...` reads as
 * the Actions tab from a blob path) and resolves against the repository URL
 * rather than the blob tree. Anything already absolute is left alone.
 *
 * @param {string} href - The link target as written in the markdown.
 * @param {string} fromSource - Repository path of the file containing the link.
 * @returns {string} The rewritten target.
 */
function rewriteLink(href, fromSource) {
  if (/^(?:[a-z]+:|#|\/\/)/iu.test(href)) {
    return href;
  }

  const [path, fragment] = href.split('#');
  const suffix = fragment ? `#${fragment}` : '';
  if (!path) {
    return href;
  }

  // Resolve the link against the directory of the file that contains it, so
  // `../docs/X.md` from inside docs/ and `docs/X.md` from the root both land
  // on the same repository path.
  const base = dirname(fromSource);
  const segments = (base === '.' ? path : `${base}/${path}`).split('/');
  const resolved = [];
  let escaped = false;
  for (const segment of segments) {
    if (segment === '.' || segment === '') {
      continue;
    }
    if (segment === '..') {
      if (resolved.length === 0) {
        // Climbed above the repository root. On GitHub that is a deliberate
        // idiom rather than a broken link: from a blob URL, `../../x` lands
        // on the repository's own `x` (the Actions tab, Issues, and so on).
        escaped = true;
      } else {
        resolved.pop();
      }
    } else {
      resolved.push(segment);
    }
  }
  const repoPath = resolved.join('/');

  if (escaped) {
    return `${REPO}/${repoPath}${suffix}`;
  }

  const published = PUBLISHED.get(repoPath);
  return published ? `${published}${suffix}` : `${BLOB}/${repoPath}${suffix}`;
}

/**
 * Renders one markdown document to HTML, collecting its top-level headings.
 *
 * @param {string} markdown - The document source.
 * @param {string} source - Repository path of the document, for link rewriting.
 * @returns {{html: string, outline: {id: string, text: string}[]}} The rendered HTML and the heading outline.
 */
function render(markdown, source) {
  const outline = [];
  const renderer = new marked.Renderer();

  renderer.heading = (text, level) => {
    const id = headingId(text);
    if (level === 2) {
      outline.push({ id, text: text.replace(/<[^>]*>/gu, '') });
    }
    return `<h${level} id="${id}">${text}</h${level}>\n`;
  };

  const baseLink = renderer.link.bind(renderer);
  renderer.link = (href, title, text) =>
    baseLink(rewriteLink(href ?? '', source), title, text);

  // Tables are wide (the threat model's mechanism map especially). Wrapping
  // each one in its own scroll container keeps a long row from widening the
  // page itself on a narrow screen.
  const baseTable = renderer.table.bind(renderer);
  renderer.table = (header, body) =>
    `<div class="table-scroll">${baseTable(header, body)}</div>`;

  return { html: marked.parse(markdown, { renderer }), outline };
}

/**
 * Wraps rendered content in the site shell.
 *
 * @param {object} page - The page being rendered.
 * @param {string} body - The rendered document HTML.
 * @param {{id: string, text: string}[]} outline - The page's second-level headings.
 * @returns {string} The complete HTML document.
 */
function layout(page, body, outline) {
  const nav = PAGES.map((entry) => {
    const href = entry.slug === 'index' ? './' : `./${entry.slug}.html`;
    const current = entry.slug === page.slug;
    return `<li><a href="${href}"${current ? ' aria-current="page"' : ''}>${escapeHtml(entry.title)}</a></li>`;
  }).join('\n          ');

  const contents = outline.length
    ? `<nav class="toc" aria-label="On this page">
            <p class="toc-title">On this page</p>
            <ul>
              ${outline.map((item) => `<li><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`).join('\n              ')}
            </ul>
          </nav>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!--
      The site is static HTML and a stylesheet: no script, no remote origin,
      no analytics. GitHub Pages sends no headers of its own, so the policy
      rides in a meta tag, where it still governs the document.
    -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    />
    <meta name="description" content="${escapeHtml(page.summary)}" />
    <title>${escapeHtml(page.title)} — Stellar Soroban Snap</title>
    <link rel="stylesheet" href="./docs.css" />
  </head>
  <body>
    <a class="skip" href="#content">Skip to content</a>
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="./">
          <span class="brand-mark" aria-hidden="true"></span>
          <span>Stellar Soroban Snap</span>
        </a>
        <nav aria-label="Documentation">
          <ul>
          ${nav}
          </ul>
        </nav>
        <p class="sidebar-foot">
          <a href="${REPO}">Source on GitHub</a>
        </p>
      </aside>
      <main id="content">
        ${contents}
        <article>
${body}
        </article>
        <footer>
          <p>
            Rendered from
            <a href="${BLOB}/${page.source}">${escapeHtml(page.source)}</a>.
            Licensed under
            <a href="${BLOB}/LICENSE">Apache 2.0</a>.
          </p>
        </footer>
      </main>
    </div>
  </body>
</html>
`;
}

/** The stylesheet, kept here so the build emits one self-contained file. */
const CSS = `/* Titillium Web (c) Accademia di Belle Arti di Urbino, SIL OFL 1.1.
   License text: ./fonts/OFL.txt */
@font-face {
  font-family: 'Titillium Web';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./fonts/titillium-web-400-latin.woff2') format('woff2');
}
@font-face {
  font-family: 'Titillium Web';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url('./fonts/titillium-web-600-latin.woff2') format('woff2');
}
@font-face {
  font-family: 'Titillium Web';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('./fonts/titillium-web-700-latin.woff2') format('woff2');
}

:root {
  --bg: #ffffff;
  --surface: #f4f6fb;
  --text: #101d3c;
  --muted: #5b6784;
  --border: #dee4f0;
  --accent: #3d5afe;
  --gold: #f5b32a;
  --code-bg: #f4f6fb;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #080d1c;
    --surface: #0e1631;
    --text: #edf1fa;
    --muted: #94a2c2;
    --border: #1e2a4c;
    --accent: #7d93ff;
    --gold: #f5b32a;
    --code-bg: #0c1327;
  }
}

* { box-sizing: border-box; }

html { font-size: 62.5%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: 'Titillium Web', -apple-system, BlinkMacSystemFont, 'Segoe UI',
    Roboto, sans-serif;
  font-size: 1.6rem;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

.skip {
  position: absolute;
  left: -9999px;
}
.skip:focus {
  left: 1.6rem;
  top: 1.6rem;
  z-index: 10;
  background: var(--gold);
  color: #17203a;
  padding: 0.8rem 1.2rem;
  border-radius: 8px;
}

.shell {
  display: grid;
  grid-template-columns: 26rem minmax(0, 1fr);
  gap: 4rem;
  max-width: 128rem;
  margin: 0 auto;
  padding: 4rem 3.2rem 8rem;
}

.sidebar {
  position: sticky;
  top: 4rem;
  align-self: start;
  border-right: 1px solid var(--border);
  padding-right: 2.4rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 1rem;
  font-weight: 700;
  color: var(--text);
  text-decoration: none;
  margin-bottom: 2.4rem;
}

.brand-mark {
  width: 1.4rem;
  height: 1.4rem;
  border-radius: 50%;
  background: var(--gold);
  flex: none;
}

.sidebar nav ul,
.toc ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.sidebar nav li { margin-bottom: 0.2rem; }

.sidebar nav a {
  display: block;
  padding: 0.6rem 1.2rem;
  border-radius: 8px;
  color: var(--muted);
  text-decoration: none;
  font-size: 1.5rem;
}

.sidebar nav a:hover {
  color: var(--text);
  background: var(--surface);
}

.sidebar nav a[aria-current='page'] {
  color: var(--text);
  background: var(--surface);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--gold);
}

.sidebar-foot {
  margin-top: 2.4rem;
  font-size: 1.4rem;
}

main { min-width: 0; }

.toc {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.6rem 2rem;
  margin-bottom: 3.2rem;
  background: var(--surface);
}

.toc-title {
  margin: 0 0 0.8rem;
  font-size: 1.2rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.toc li { margin: 0.2rem 0; }

.toc a {
  color: var(--muted);
  text-decoration: none;
  font-size: 1.45rem;
}

.toc a:hover { color: var(--text); }

article { max-width: 82ch; }

article h1 {
  font-size: 3.6rem;
  line-height: 1.15;
  letter-spacing: -0.015em;
  margin: 0 0 2.4rem;
}

article h2 {
  font-size: 2.4rem;
  margin: 4.8rem 0 1.6rem;
  padding-top: 1.6rem;
  border-top: 1px solid var(--border);
  letter-spacing: -0.01em;
}

article h3 { font-size: 1.9rem; margin: 3.2rem 0 1.2rem; }
article h4 { font-size: 1.6rem; margin: 2.4rem 0 1rem; }

article p, article li { color: var(--text); }

a { color: var(--accent); }

article code {
  font-family: ui-monospace, SFMono-Regular, Menlo, 'Roboto Mono', monospace;
  font-size: 0.9em;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0.1rem 0.5rem;
}

article pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.6rem 2rem;
  overflow-x: auto;
  font-size: 1.4rem;
}

article pre code {
  background: none;
  border: none;
  padding: 0;
  font-size: 1.4rem;
}

article blockquote {
  margin: 2.4rem 0;
  padding: 0.4rem 0 0.4rem 2rem;
  border-left: 3px solid var(--gold);
  color: var(--muted);
}

.table-scroll {
  overflow-x: auto;
  margin: 2.4rem 0;
  border: 1px solid var(--border);
  border-radius: 12px;
}

table {
  border-collapse: collapse;
  width: 100%;
  font-size: 1.45rem;
}

th, td {
  text-align: left;
  padding: 1rem 1.4rem;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

th {
  font-size: 1.2rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  white-space: nowrap;
}

tr:last-child td { border-bottom: none; }

article img { max-width: 100%; }

article hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 4rem 0;
}

footer {
  margin-top: 6.4rem;
  padding-top: 2.4rem;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 1.4rem;
}

@media (max-width: 860px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
    gap: 2.4rem;
    padding: 2.4rem 1.6rem 4.8rem;
  }

  .sidebar {
    position: static;
    border-right: none;
    border-bottom: 1px solid var(--border);
    padding-right: 0;
    padding-bottom: 1.6rem;
  }

  .sidebar nav ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  article h1 { font-size: 2.8rem; }
  article h2 { font-size: 2.1rem; }
}
`;

/**
 * Verifies that every public method of the connector's client is documented.
 *
 * The API reference is written by hand, which is the right trade for prose
 * that explains *why* a method behaves as it does. The failure mode of a
 * hand-written reference is silent drift: a method is added, nobody updates
 * the page, and the documentation quietly describes a smaller API than the
 * one that ships. This is cheap insurance against exactly that, and it runs
 * in CI as part of the docs build.
 *
 * @returns {Promise<number>} How many public methods were verified.
 * @throws When a public method is missing from the reference.
 */
async function checkConnectorCoverage() {
  const [source, reference] = await Promise.all([
    readFile(join(ROOT, 'packages/connector/src/snap.ts'), 'utf8'),
    readFile(join(ROOT, 'docs/CONNECTOR-API.md'), 'utf8'),
  ]);

  // Public instance methods: `  async name(` at class-body indentation.
  // Private ones carry the `#` prefix and are excluded by the pattern.
  const methods = [...source.matchAll(/^ {2}async ([a-zA-Z][\w]*)\(/gmu)].map(
    (match) => match[1],
  );
  const missing = methods.filter((name) => !reference.includes(`${name}(`));

  if (missing.length > 0) {
    throw new Error(
      `docs/CONNECTOR-API.md does not document: ${missing.join(', ')}. ` +
        `Add them, or the published reference describes a smaller API than ships.`,
    );
  }
  return methods.length;
}

/**
 * Builds the site.
 *
 * @returns {Promise<void>} Resolves once every page is written.
 */
async function build() {
  const documented = await checkConnectorCoverage();

  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, 'fonts'), { recursive: true });

  await Promise.all(
    PAGES.map(async (page) => {
      const markdown = await readFile(join(ROOT, page.source), 'utf8');
      const { html, outline } = render(markdown, page.source);
      const name = page.slug === 'index' ? 'index.html' : `${page.slug}.html`;
      return writeFile(join(OUT, name), layout(page, html, outline), 'utf8');
    }),
  );

  await writeFile(join(OUT, 'docs.css'), CSS, 'utf8');

  // GitHub Pages runs Jekyll over the artifact unless told not to, which
  // strips files and directories beginning with an underscore.
  await writeFile(join(OUT, '.nojekyll'), '', 'utf8');

  const fontDir = join(ROOT, 'packages/site/static/fonts');
  await Promise.all(
    (await readdir(fontDir)).map(async (file) =>
      copyFile(join(fontDir, file), join(OUT, 'fonts', file)),
    ),
  );

  process.stdout.write(
    `Built ${PAGES.length} pages into docs-site/ ` +
      `(${documented} connector methods verified as documented).\n`,
  );
}

await build();
