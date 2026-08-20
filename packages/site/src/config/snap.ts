/**
 * The snap origin to use.
 * Will default to the local hosted snap if no value is provided in environment.
 *
 * You may be tempted to change this to the URL where your production snap is hosted, but please
 * don't. Instead, rename `.env.production.dist` to `.env.production` and set the production URL
 * there. Running `yarn build` will automatically use the production environment variables.
 */
/*
 * The `GATSBY_` prefix is required, not decorative. Gatsby's documented
 * contract is that only prefixed variables are embedded in browser code;
 * unprefixed ones are available to Node during the build but are not
 * guaranteed to reach the client. Earlier revisions of this file read
 * `SNAP_ORIGIN`, which did in fact get substituted by the Gatsby version in
 * use, but relied on undocumented behaviour that an upgrade could withdraw,
 * silently leaving production builds on the localhost development snap. The
 * prefixed names make the guarantee explicit. `gatsby-node.js` additionally
 * verifies the emitted JavaScript after every release build, so a regression
 * here fails the build rather than shipping.
 */
export const defaultSnapOrigin =
  // eslint-disable-next-line no-restricted-globals
  process.env.GATSBY_SNAP_ORIGIN ?? `local:http://localhost:8080`;

/**
 * The exact snap version to request at install time. Production builds must
 * set `GATSBY_SNAP_VERSION` in `.env.production` to the audited release version so
 * installs are pinned to the audited artifact. It may be left unset for
 * `local:` origins during development.
 */
export const defaultSnapVersion: string | undefined =
  // eslint-disable-next-line no-restricted-globals
  process.env.GATSBY_SNAP_VERSION;

/**
 * Whether the page renders the connector bench: the panel of raw SEP-43
 * method buttons (including a `signMessage` and a self-transfer Soroban
 * `signTransaction`) with the JSON response shown verbatim.
 *
 * The bench is a development and review surface, not part of the wallet
 * product, so it is off unless `GATSBY_DEV_BENCH` is exactly `true`. Every
 * action it offers still goes through a MetaMask dialog, so shipping it would
 * not be a vulnerability, but a production page should not present a row of
 * "sign something" buttons and a raw signed-envelope dump to users who came
 * to hold and send assets. The production build guard in `gatsby-node.js`
 * refuses to build with the flag set, so it cannot reach a release artifact
 * by way of a stray environment variable.
 */
export const devBenchEnabled: boolean =
  // eslint-disable-next-line no-restricted-globals
  process.env.GATSBY_DEV_BENCH === 'true';
