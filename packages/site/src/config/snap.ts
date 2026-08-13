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
