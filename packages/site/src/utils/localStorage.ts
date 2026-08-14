/**
 * Get a local storage key.
 *
 * Access is wrapped in try/catch because the realistic failure mode is not a
 * null `window.localStorage`: Safari in private mode, sandboxed iframes, and
 * profiles with cookies blocked throw a SecurityError on the property access
 * itself. Nothing stored here (a theme preference) is worth a render-time
 * throw, which would blank the whole page, so failures degrade to "no stored
 * value".
 *
 * @param key - The local storage key to access.
 * @returns The value stored at the key provided, or null when the key does
 * not exist or storage is unavailable.
 */
export const getLocalStorage = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * Set a value to local storage at a certain key.
 *
 * Best effort, for the same reason as {@link getLocalStorage}: when storage
 * is unavailable the only loss is persistence across reloads.
 *
 * @param key - The local storage key to set.
 * @param value - The value to set.
 */
export const setLocalStorage = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the preference simply is not persisted.
  }
};
