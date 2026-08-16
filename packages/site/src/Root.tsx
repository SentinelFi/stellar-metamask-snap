import type { FunctionComponent, ReactNode } from 'react';
import { createContext, useState } from 'react';
import { ThemeProvider } from 'styled-components';

import { dark, light } from './config/theme';
import { MetaMaskProvider, WalletProvider } from './hooks';
import { getThemePreference, setLocalStorage } from './utils';

export type RootProps = {
  children: ReactNode;
};

type ToggleTheme = () => void;

export const ToggleThemeContext = createContext<ToggleTheme>(
  (): void => undefined,
);

export const Root: FunctionComponent<RootProps> = ({ children }) => {
  // Lazy initializer: the storage read runs once on mount, not on every
  // render. Persisting the preference happens here in the toggle handler,
  // the one place the user actually changes it; the read path stays pure.
  const [darkTheme, setDarkTheme] = useState(getThemePreference);

  const toggleTheme: ToggleTheme = () => {
    setLocalStorage('theme', darkTheme ? 'light' : 'dark');
    setDarkTheme(!darkTheme);
  };

  return (
    <ToggleThemeContext.Provider value={toggleTheme}>
      <ThemeProvider theme={darkTheme ? dark : light}>
        <MetaMaskProvider>
          <WalletProvider>{children}</WalletProvider>
        </MetaMaskProvider>
      </ThemeProvider>
    </ToggleThemeContext.Provider>
  );
};
