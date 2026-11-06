import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'awspm-theme';

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function resolve(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return pref;
}

function apply(pref: ThemePreference) {
  document.documentElement.dataset.theme = resolve(pref);
}

/**
 * App-wide theme preference (System / Light / Dark), persisted in localStorage.
 * The resolved light|dark value is written to <html data-theme> so the CSS
 * variables in index.css take effect. An inline script in index.html applies
 * the stored preference before first paint to avoid a flash.
 */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    return (localStorage.getItem(STORAGE_KEY) as ThemePreference) || 'system';
  });

  useEffect(() => {
    apply(preference);
    localStorage.setItem(STORAGE_KEY, preference);
  }, [preference]);

  useEffect(() => {
    if (preference !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preference]);

  const setTheme = useCallback((p: ThemePreference) => setPreference(p), []);

  return { preference, resolved: resolve(preference), setTheme };
}
