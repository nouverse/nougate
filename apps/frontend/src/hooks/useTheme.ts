import { useState, useEffect } from 'react';

export type Theme = 'nougate' | 'nougate-light';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('nougate-theme') as Theme;
    if (saved === 'nougate' || saved === 'nougate-light') return saved;
    return 'nougate';
  });

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    localStorage.setItem('nougate-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'nougate' ? 'nougate-light' : 'nougate'));
  };

  return { theme, toggleTheme, setTheme };
}
