import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '../api';
import type { AppState, Portal, Project } from '../types';

export type Dialog =
  | { kind: 'project'; project?: Project }
  | { kind: 'portal'; portal?: Portal; projectId?: string; then?: 'add-sso' }
  | { kind: 'sign-in'; portalId: string; then?: Dialog }
  | { kind: 'add-sso'; projectId: string; portalId?: string }
  | { kind: 'paste'; projectId?: string; profileId?: string }
  | { kind: 'settings' }
  | { kind: 'move'; profileId: string }
  | { kind: 'next'; projectId: string }
  | {
      kind: 'confirm';
      title: string;
      body: ReactNode;
      confirmLabel: string;
      danger?: boolean;
      /** An optional checkbox; its value is passed to onConfirm. */
      option?: { label: ReactNode; defaultChecked: boolean };
      onConfirm: (option: boolean) => Promise<unknown>;
    };

export interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'info';
}

interface AppContextValue {
  state: AppState;
  now: number;
  refresh: () => Promise<void>;
  dialog: Dialog | null;
  open: (dialog: Dialog) => void;
  close: () => void;
  toasts: Toast[];
  toast: (message: string, tone?: Toast['tone']) => void;
  /** Runs an action: refreshes after it, shows its error as a toast, and resolves to whether it worked. */
  run: (action: () => Promise<unknown>, success?: string) => Promise<boolean>;
}

const Ctx = createContext<AppContextValue | null>(null);

let toastId = 0;

export function AppProvider({ state, now, refresh, children }: { state: AppState; now: number; refresh: () => Promise<void>; children: ReactNode }) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Stable, like `open`: dialogs list it in effect dependencies, and the context value is rebuilt every `now` tick.
  const close = useCallback(() => setDialog(null), []);

  const toast = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = ++toastId;
    setToasts(t => [...t, { id, message, tone }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), tone === 'error' || message.length > 80 ? 7000 : 3500);
  }, []);

  const run = useCallback(
    async (action: () => Promise<unknown>, success?: string) => {
      try {
        await action();
        if (success) toast(success);
        return true;
      } catch (err) {
        toast(errorMessage(err), 'error');
        return false;
      } finally {
        await refresh();
      }
    },
    [refresh, toast],
  );

  const value = useMemo<AppContextValue>(
    () => ({ state, now, refresh, dialog, open: setDialog, close, toasts, toast, run }),
    [state, now, refresh, dialog, close, toasts, toast, run],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useApp outside AppProvider');
  return value;
}

/** Lookups the pages share. */
export function useLookups() {
  const { state } = useApp();
  return useMemo(() => {
    const projects = new Map(state.projects.map(p => [p.id, p]));
    const portals = new Map(state.portals.map(p => [p.id, p]));
    const account = (accountId: string | null) => (accountId ? state.accounts[accountId] : undefined);
    return { projects, portals, account };
  }, [state]);
}
