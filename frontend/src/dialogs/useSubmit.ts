import { useState } from 'react';
import { errorMessage } from '../api';
import { useApp } from '../lib/appContext';

/** Busy/error state for a dialog's main action; refreshes the app state after it either way. */
export function useSubmit() {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setBusy(false);
      void refresh();
    }
  };
  return { busy, error, setError, submit };
}
