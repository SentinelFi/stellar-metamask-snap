import { getLocalStorage } from './localStorage';

/**
 * Get the user's preferred theme from local storage.
 * Will default to the browser's preferred theme if there is no value in local
 * storage.
 *
 * This is a pure read: it deliberately does not write the resolved default
 * back to storage. It runs inside render (a `useState` initializer), and a
 * write there is a side effect during render; persisting the preference is
 * done where the user actually changes it (the toggle handler in Root).
 *
 * @returns True if the theme is "dark" otherwise, false.
 */
export const getThemePreference = () => {
  if (typeof window === 'undefined') {
    return false;
  }

  const darkModeSystem = window.matchMedia(
    '(prefers-color-scheme: dark)',
  ).matches;

  const localStoragePreference = getLocalStorage('theme');
  const systemPreference = darkModeSystem ? 'dark' : 'light';
  const preference = localStoragePreference ?? systemPreference;

  return preference === 'dark';
};
