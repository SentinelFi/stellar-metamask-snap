import type { DefaultTheme } from 'styled-components';
import { createGlobalStyle } from 'styled-components';

const breakpoints = ['600px', '768px', '992px'];

/**
 * Common theme properties.
 *
 * The typeface is Titillium Web, self-hosted from `static/fonts` rather than
 * loaded from a font CDN. Two reasons, in order of weight: the site ships a
 * Content-Security-Policy with no remote origins at all (`static/_headers`),
 * and a wallet-facing page has no business announcing every visitor to a
 * third party through a font request.
 */
const theme = {
  fonts: {
    default:
      "'Titillium Web',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif",
    code: "ui-monospace,SFMono-Regular,Menlo,Monaco,'Cascadia Mono','Roboto Mono','Source Code Pro','Fira Mono',monospace",
  },
  fontSizes: {
    heading: '4rem',
    mobileHeading: '2.8rem',
    title: '2.2rem',
    large: '1.8rem',
    text: '1.6rem',
    small: '1.4rem',
    tiny: '1.2rem',
  },
  radii: {
    default: '16px',
    button: '10px',
    pill: '999px',
  },
  breakpoints,
  mediaQueries: {
    small: `@media screen and (max-width: ${breakpoints[0] as string})`,
    medium: `@media screen and (min-width: ${breakpoints[1] as string})`,
    large: `@media screen and (min-width: ${breakpoints[2] as string})`,
  },
  shadows: {
    default:
      '0 1px 2px rgba(8, 14, 32, 0.04), 0 12px 32px rgba(8, 14, 32, 0.07)',
    button: '0 1px 2px rgba(8, 14, 32, 0.10)',
    panel: '0 1px 3px rgba(8, 14, 32, 0.06)',
  },
};

/*
 * The palette is the snap's own colorway: deep Stellar navy carrying a single
 * gold accent, the same pairing as the product icon the connector hands to the
 * Stellar Wallets Kit. One accent, used only for the primary action and the
 * active state, is what keeps a wallet UI readable: if everything is
 * highlighted, the button that moves money is not.
 */

/**
 * Light theme color properties.
 */
export const light: DefaultTheme = {
  colors: {
    background: {
      default: '#FFFFFF',
      alternative: '#F4F6FB',
      inverse: '#101D3C',
    },
    icon: {
      default: '#101D3C',
      alternative: '#8A96B2',
    },
    text: {
      default: '#101D3C',
      muted: '#5B6784',
      alternative: '#33415C',
      inverse: '#FFFFFF',
    },
    border: {
      default: '#DEE4F0',
      strong: '#C3CDE2',
    },
    primary: {
      default: '#F5B32A',
      hover: '#E3A319',
      inverse: '#17203A',
      muted: '#F5B32A1f',
    },
    accent: {
      default: '#3D5AFE',
      muted: '#3D5AFE14',
    },
    card: {
      default: '#FFFFFF',
      raised: '#FFFFFF',
    },
    error: {
      default: '#D93A49',
      alternative: '#B02534',
      muted: '#D93A4914',
    },
    success: {
      default: '#1E9E62',
      alternative: '#16794A',
      muted: '#1E9E6214',
    },
    warning: {
      default: '#B4740A',
      alternative: '#8A5906',
      muted: '#F5B32A1f',
    },
  },
  ...theme,
};

/**
 * Dark theme color properties.
 */
export const dark: DefaultTheme = {
  colors: {
    background: {
      default: '#080D1C',
      alternative: '#0E1631',
      inverse: '#F4F6FB',
    },
    icon: {
      default: '#F4F6FB',
      alternative: '#8A96B2',
    },
    text: {
      default: '#EDF1FA',
      muted: '#94A2C2',
      alternative: '#C6D0E6',
      inverse: '#101D3C',
    },
    border: {
      default: '#1E2A4C',
      strong: '#2C3B65',
    },
    primary: {
      default: '#F5B32A',
      hover: '#FFC44D',
      inverse: '#17203A',
      muted: '#F5B32A1a',
    },
    accent: {
      default: '#7D93FF',
      muted: '#7D93FF1a',
    },
    card: {
      default: '#0C1327',
      raised: '#111B38',
    },
    error: {
      default: '#FF6B6B',
      alternative: '#FF9A9A',
      muted: '#FF6B6B1a',
    },
    success: {
      default: '#3ED08A',
      alternative: '#7FE2B4',
      muted: '#3ED08A1a',
    },
    warning: {
      default: '#F5B32A',
      alternative: '#FFD07A',
      muted: '#F5B32A1a',
    },
  },
  ...theme,
  shadows: {
    default: '0 1px 2px rgba(0, 0, 0, 0.4), 0 16px 40px rgba(0, 0, 0, 0.35)',
    button: '0 1px 2px rgba(0, 0, 0, 0.4)',
    panel: '0 1px 3px rgba(0, 0, 0, 0.35)',
  },
};

/**
 * Default style applied to the app.
 *
 * The `@font-face` rules point at `/fonts/*.woff2`, copied verbatim from
 * `static/fonts`. Titillium Web is licensed under the SIL Open Font License
 * 1.1, whose text ships alongside the files as `static/fonts/OFL.txt` and is
 * therefore served with the site, which is what the license asks of a
 * redistributor.
 *
 * @param props - Styled Components props.
 * @param props.theme - The active theme.
 * @returns Global style React component.
 */
export const GlobalStyle = createGlobalStyle`
  /* Titillium Web (c) Accademia di Belle Arti di Urbino, SIL OFL 1.1.
     License: /fonts/OFL.txt */
  @font-face {
    font-family: 'Titillium Web';
    font-style: normal;
    font-weight: 400;
    font-display: swap;
    src: url('/fonts/titillium-web-400-latin.woff2') format('woff2');
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6,
      U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122,
      U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face {
    font-family: 'Titillium Web';
    font-style: normal;
    font-weight: 400;
    font-display: swap;
    src: url('/fonts/titillium-web-400-latin-ext.woff2') format('woff2');
    unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7,
      U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F,
      U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F,
      U+A720-A7FF;
  }
  @font-face {
    font-family: 'Titillium Web';
    font-style: normal;
    font-weight: 600;
    font-display: swap;
    src: url('/fonts/titillium-web-600-latin.woff2') format('woff2');
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6,
      U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122,
      U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face {
    font-family: 'Titillium Web';
    font-style: normal;
    font-weight: 600;
    font-display: swap;
    src: url('/fonts/titillium-web-600-latin-ext.woff2') format('woff2');
    unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7,
      U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F,
      U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F,
      U+A720-A7FF;
  }
  @font-face {
    font-family: 'Titillium Web';
    font-style: normal;
    font-weight: 700;
    font-display: swap;
    src: url('/fonts/titillium-web-700-latin.woff2') format('woff2');
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6,
      U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122,
      U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face {
    font-family: 'Titillium Web';
    font-style: normal;
    font-weight: 700;
    font-display: swap;
    src: url('/fonts/titillium-web-700-latin-ext.woff2') format('woff2');
    unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7,
      U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F,
      U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F,
      U+A720-A7FF;
  }

  html {
    /* 62.5% of the base size of 16px = 10px.*/
    font-size: 62.5%;
  }

  body {
    background-color: ${(props) => props.theme.colors.background?.default};
    background-image: ${(props) =>
      `radial-gradient(80rem 40rem at 50% -12rem, ${
        props.theme.colors.primary?.muted ?? 'transparent'
      }, transparent 70%)`};
    background-repeat: no-repeat;
    color: ${(props) => props.theme.colors.text?.default};
    font-family: ${(props) => props.theme.fonts.default};
    font-size: ${(props) => props.theme.fontSizes.text};
    line-height: 1.5;
    margin: 0;
    -webkit-font-smoothing: antialiased;
  }

  h1, h2, h3, h4, h5, h6 {
    line-height: 1.2;
    letter-spacing: -0.01em;
  }

  h1 {
    font-size: ${(props) => props.theme.fontSizes.heading};
    ${(props) => props.theme.mediaQueries.small} {
      font-size: ${(props) => props.theme.fontSizes.mobileHeading};
    }
  }

  h2 { font-size: ${(props) => props.theme.fontSizes.title}; }
  h3 { font-size: ${(props) => props.theme.fontSizes.large}; }
  h4, h5, h6 { font-size: ${(props) => props.theme.fontSizes.text}; }

  a {
    color: ${(props) => props.theme.colors.accent?.default};
  }

  code {
    background-color: ${(props) => props.theme.colors.background?.alternative};
    font-family: ${(props) => props.theme.fonts.code};
    border-radius: 6px;
    padding: 0.2rem 0.6rem;
    font-weight: normal;
    font-size: ${(props) => props.theme.fontSizes.small};
  }

  /*
   * Only typography and cursor here. Appearance belongs to the button
   * components: a blanket rule that paints every button in the app fights
   * every variant that is not the primary action, and the loser is usually
   * the quiet one (Cancel, Remove) that most needs to look different from
   * the one that signs.
   */
  button {
    font-family: inherit;
    font-size: ${(props) => props.theme.fontSizes.small};
    cursor: pointer;
  }

  button:disabled,
  button[disabled] {
    cursor: not-allowed;
  }

  input, select, textarea {
    font-family: inherit;
  }

  *:focus-visible {
    outline: 2px solid ${(props) => props.theme.colors.primary?.default};
    outline-offset: 2px;
  }
`;
