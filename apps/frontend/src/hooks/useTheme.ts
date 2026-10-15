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

/** The host's two modes, as it names them in its messages and in the page address. */
function fromHost(mode: string | null | undefined): Theme | null {
  if (mode === 'light') return 'nougate-light';
  if (mode === 'dark') return 'nougate';
  return null;
}

/**
 * The theme inside a host's dashboard: whatever the host is showing, never a choice of this page's.
 *
 * Two sources, both the host's. `?theme=` on the address it framed this page with, read before the
 * first paint so a light host does not flash a dark page; then a `nouride:theme` message each time
 * the host's own switch is flipped. Not written to storage: the host remembers, and a value kept
 * here would be a second opinion that goes stale the first time the host changes its mind.
 */
export function useHostTheme(): void {
  useEffect(() => {
    const root = document.documentElement;
    const initial = fromHost(new URLSearchParams(window.location.search).get('theme'));
    if (initial) root.setAttribute('data-theme', initial);

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'nouride:theme') return;
      const next = fromHost(event.data.theme);
      if (next) root.setAttribute('data-theme', next);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
}
