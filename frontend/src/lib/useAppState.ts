import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { AppState } from '../types';

const POLL_MS = 10_000;

/**
 * The service's snapshot, refreshed every 10 s, when the window regains
 * focus, and on demand after a change.
 */
export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    if (!inFlight.current) {
      inFlight.current = api
        .getState()
        .then(s => {
          setState(s);
          setError(null);
        })
        .catch(err => setError(errorMessage(err)))
        .finally(() => {
          inFlight.current = null;
        });
    }
    return inFlight.current;
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return { state, error, refresh };
}

/** The current time, ticking every second, for countdowns. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
