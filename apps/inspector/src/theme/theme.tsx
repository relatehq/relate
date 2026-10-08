import { createContext, useContext, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export type ThemeState = {
  readonly theme: Theme;
  readonly toggle: () => void;
};

const themeKey = 'relate-inspector-theme';

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(themeKey);

    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Follow the system color scheme until the header toggle picks one, using the
 * design system's .light/.dark class convention on <html>.
 */
export function useThemeState(): ThemeState {
  const [media] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)'),
  );
  const [chosen, setChosen] = useState<Theme | null>(storedTheme);
  const [systemDark, setSystemDark] = useState(media.matches);
  const theme = chosen ?? (systemDark ? 'dark' : 'light');

  useEffect(() => {
    const onChange = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches);

    media.addEventListener('change', onChange);

    return () => media.removeEventListener('change', onChange);
  }, [media]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.classList.toggle('light', theme === 'light');
  }, [theme]);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';

    setChosen(next);

    try {
      window.localStorage.setItem(themeKey, next);
    } catch {
      // Storage can be unavailable; the choice still applies to this tab.
    }
  };

  return { theme, toggle };
}

export const ThemeContext = createContext<ThemeState | null>(null);

/** The resolved theme and its toggle, provided by the inspector shell. */
export function useTheme(): ThemeState {
  const theme = useContext(ThemeContext);

  if (!theme) throw new Error('useTheme must be used inside InspectorShell');

  return theme;
}
