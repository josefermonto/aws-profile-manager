import { useEffect, useState } from 'react';
import { Bell, Check, FileText, Terminal } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../lib/appContext';
import { CopyButton, Hint, Modal } from '../components/ui';

/** Settings, in a dialog off the top bar: alerts, the terminal helper, file locations. */
export function SettingsDialog() {
  const { state, run, open, close, toast } = useApp();
  const [warn, setWarn] = useState(String(state.settings.warnMinutes));
  useEffect(() => setWarn(String(state.settings.warnMinutes)), [state.settings.warnMinutes]);

  const testNotification = async () => {
    try {
      const r = await api.testNotification();
      toast(r.shown ? 'A test alert is on your screen.' : r.unsupported ? 'Alerts only work on macOS.' : "The alert couldn't be shown. See the service log.", r.shown ? 'success' : 'info');
    } catch {
      toast("Couldn't show an alert.", 'error');
    }
  };

  return (
    <Modal title="Settings" onClose={close} wide>
      <div className="space-y-5">

      <section className="card space-y-4 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-heading"><Bell size={15} /> Expiry alerts</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="field-label" htmlFor="warn">Warn this many minutes before</label>
            <input id="warn" type="number" min={1} max={240} value={warn} onChange={e => setWarn(e.target.value)} className="field w-28" />
          </div>
          <button className="btn" disabled={Number(warn) === state.settings.warnMinutes} onClick={() => void run(() => api.updateSettings({ warnMinutes: Number(warn) }), 'Saved.')}>
            Save
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={state.settings.notifications} onChange={e => void run(() => api.updateSettings({ notifications: e.target.checked }))} />
          macOS alerts when a sign-in is about to end or has ended, and when keys are about to expire or have
        </label>
        <div>
          <button className="btn" onClick={() => void testNotification()}>Show a test alert</button>
          <Hint>
            A pop-up with <strong>Sign in again</strong> (or <strong>Paste new keys</strong>) and <strong>Ignore</strong>, shown by the background service, so it
            appears with no browser tab open. Ignore silences that sign-in until the next one. For SSO, alerts go out only for what AWS confirmed: about 20
            minutes before the end, and when it has ended.
          </Hint>
        </div>
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-heading"><Terminal size={15} /> Terminal helper</h2>
        <p className="text-xs text-muted">
          <code className="font-mono">awspm use &lt;profile&gt;</code> sets <code className="font-mono">AWS_PROFILE</code> in that terminal only, with tab completion, and shows the
          profile as a colored tag in your prompt. <code className="font-mono">awspm ls</code> lists profiles, <code className="font-mono">awspm off</code> clears it.
        </p>
        {state.shell.installed ? (
          <p className="flex items-center gap-1.5 text-xs text-success"><Check size={13} /> Installed in {state.shell.zshrc}. Open a new terminal to use it.</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface-alt px-3 py-2 font-mono text-[0.6875rem]">{state.shell.sourceLine}</code>
              <CopyButton text={state.shell.sourceLine} label="Copy" />
            </div>
            <button
              className="btn-primary"
              onClick={() =>
                open({
                  kind: 'confirm',
                  title: 'Add the helper to ~/.zshrc?',
                  body: <>Appends the line above to <code className="font-mono">{state.shell.zshrc}</code>. A copy of the current file goes to the backups folder first.</>,
                  confirmLabel: 'Add to ~/.zshrc',
                  onConfirm: () => api.installShell(),
                })
              }
            >
              Add to ~/.zshrc
            </button>
          </>
        )}
      </section>

      <section className="card space-y-2 p-5 text-xs">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-heading"><FileText size={15} /> Files</h2>
        <Row label="AWS config" value={state.paths.config} />
        <Row label="AWS credentials" value={state.paths.credentials} />
        <Row label="App data (no secrets)" value={state.paths.appHome} />
        <Row label="Backups (last 20 per file)" value={state.paths.backups} />
        <Hint>
          Runs as a background service at <code className="font-mono">http://localhost:{state.port}</code>. Manage it with{' '}
          <code className="font-mono">npm run service:status</code>, <code className="font-mono">service:restart</code>, <code className="font-mono">service:uninstall</code>.
        </Hint>
      </section>
      </div>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-48 shrink-0 text-muted">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-text">{value}</code>
      <CopyButton text={value} className="btn-ghost" />
    </div>
  );
}
