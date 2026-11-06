import { useEffect } from 'react';
import { Loader2, ServerCrash } from 'lucide-react';
import { useAppState, useNow } from './lib/useAppState';
import { AppProvider, useApp } from './lib/appContext';
import { liveState } from './lib/format';
import { TopBar } from './components/Layout';
import { AwsLogo } from './components/AwsLogo';
import { Toasts } from './components/ui';
import { ProfilesTable } from './components/ProfilesTable';
import { ConfirmDialog, MoveDialog, NextStepDialog, ProjectDialog } from './dialogs/SimpleDialogs';
import { AddSsoDialog, PortalDialog, SignInDialog } from './dialogs/SsoDialogs';
import { PasteDialog } from './dialogs/PasteDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';

export default function App() {
  const { state, error, refresh } = useAppState();
  const now = useNow();

  if (!state) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted">
        <AwsLogo size={48} />
        {error ? (
          <>
            <p className="flex items-center gap-2 text-danger"><ServerCrash size={16} /> {error}</p>
            <button className="btn" onClick={() => void refresh()}>Retry</button>
          </>
        ) : (
          <p className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</p>
        )}
      </div>
    );
  }

  return (
    <AppProvider state={state} now={now} refresh={refresh}>
      <Shell offline={error} />
    </AppProvider>
  );
}

/** One page: the top bar and the table. Everything else opens as a dialog over it. */
function Shell({ offline }: { offline: string | null }) {
  useDocumentTitle();
  useAlertLinks();
  return (
    <>
      <TopBar />
      {offline && <div className="border-b border-danger-border bg-danger-bg px-4 py-1.5 text-xs text-danger">{offline} Showing the last known state.</div>}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <ProfilesTable />
      </main>
      <ActiveDialog />
      <Toasts />
    </>
  );
}

function ActiveDialog() {
  const { dialog } = useApp();
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'project':
      return <ProjectDialog project={dialog.project} />;
    case 'next':
      return <NextStepDialog projectId={dialog.projectId} />;
    case 'portal':
      return <PortalDialog portal={dialog.portal} projectId={dialog.projectId} then={dialog.then} />;
    case 'sign-in':
      return <SignInDialog key={dialog.portalId} portalId={dialog.portalId} then={dialog.then} />;
    case 'add-sso':
      return <AddSsoDialog key={`${dialog.projectId}/${dialog.portalId ?? ''}`} projectId={dialog.projectId} portalId={dialog.portalId} />;
    case 'paste':
      return <PasteDialog projectId={dialog.projectId} profileId={dialog.profileId} />;
    case 'move':
      return <MoveDialog profileId={dialog.profileId} />;
    case 'settings':
      return <SettingsDialog />;
    case 'confirm':
      return <ConfirmDialog {...dialog} />;
  }
}

/**
 * The macOS alerts' buttons open the app at what they offer: #sign-in=<portal id>
 * or #paste=<profile id>. The link is cleared once its dialog is open.
 */
function useAlertLinks() {
  const { state, open } = useApp();
  useEffect(() => {
    const follow = () => {
      const [kind, id] = window.location.hash.slice(1).split('=');
      if (kind === 'sign-in' && state.portals.some(p => p.id === id)) open({ kind: 'sign-in', portalId: id });
      else if (kind === 'paste' && state.profiles.some(p => p.id === id)) open({ kind: 'paste', profileId: id });
      else return;
      history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [state.portals, state.profiles, open]);
}

/** "⚠ 2 need attention · AWS Profile Manager" in the tab title, so a background tab still tells you. */
function useDocumentTitle() {
  const { state, now } = useApp();
  let expired = 0;
  let expiring = 0;
  for (const p of state.profiles) {
    const s = liveState(p.status, now, state.settings.warnMinutes);
    if (s === 'expired' || s === 'error') expired += 1;
    else if (s === 'expiring') expiring += 1;
  }
  const title = expired ? `⚠ ${expired} need attention · AWS Profile Manager` : expiring ? `${expiring} expiring · AWS Profile Manager` : 'AWS Profile Manager';
  useEffect(() => {
    document.title = title;
  }, [title]);
}
