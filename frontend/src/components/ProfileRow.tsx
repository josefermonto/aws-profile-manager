import { useState } from 'react';
import { AlertTriangle, ClipboardPaste, FolderInput, KeyRound, LogIn, RefreshCw, Terminal, Trash2, Unlink } from 'lucide-react';
import { api } from '../api';
import { useApp, useLookups } from '../lib/appContext';
import { liveState } from '../lib/format';
import type { LabelColor, Profile } from '../types';
import { ColorSwatches, CopyButton, LabelTag, Menu, Popover, StatusChip } from './ui';
import { RegionInput } from './RegionInput';

/**
 * One profile as a table row: account (label, name, number: click the label to
 * edit it for the whole account), role, profile name, region (click to change),
 * status with a countdown, and what to do about it.
 */
export function ProfileRow({ profile, portalShown }: { profile: Profile; portalShown: boolean }) {
  const { open, run, now, state } = useApp();
  const { portals } = useLookups();
  const portal = profile.sso ? portals.get(profile.sso.portalId) : undefined;
  const live = liveState(profile.status, now, state.settings.warnMinutes);
  const needsSignIn = profile.kind === 'sso' && ['signed-out', 'expired', 'expiring'].includes(live);
  const needsKeys = profile.kind === 'keys' && profile.keys?.temporary && ['expired', 'expiring', 'error'].includes(live);
  const exportLine = `export AWS_PROFILE=${/^[\w.-]+$/.test(profile.name) ? profile.name : `'${profile.name}'`}`;
  // Under a project whose header shows the sign-in, its time and its Sign in button are shown once there.
  const underPortal = portalShown && profile.kind === 'sso';

  const confirmRemove = (deleteFromFiles: boolean) =>
    open({
      kind: 'confirm',
      title: deleteFromFiles ? `Delete ${profile.name}?` : `Stop managing ${profile.name}?`,
      body: deleteFromFiles ? (
        <>Removes <code className="font-mono">{profile.name}</code> from <code>~/.aws/config</code>{profile.kind === 'keys' && <> and <code>~/.aws/credentials</code></>}. A backup of each file is kept first.</>
      ) : (
        <>The profile stays in your AWS files exactly as it is and moves to Unmanaged.</>
      ),
      confirmLabel: deleteFromFiles ? 'Delete' : 'Stop managing',
      danger: deleteFromFiles,
      onConfirm: () => api.removeProfile(profile.id, deleteFromFiles),
    });

  return (
    <>
      <tr className="border-t border-border hover:bg-surface-hover/50">
        <td className="py-2 pl-9 pr-3">
          <AccountCell accountId={profile.accountId} />
        </td>
        <td className="px-3 py-2">
          <div className="text-[0.8125rem] text-text">{profile.label || <span className="text-faint">—</span>}</div>
          <div className="text-[0.6875rem] text-muted">{profile.kind === 'sso' ? portal?.name ?? 'SSO' : profile.keys?.temporary ? 'Pasted keys' : 'Long-lived keys'}</div>
        </td>
        <td className="px-3 py-2">
          <span className="block truncate font-mono text-[0.78125rem] font-semibold text-heading" title={profile.name}>{profile.name}</span>
          {profile.sso?.exportKeys && (
            <div className="font-mono text-[0.6875rem] text-muted" title="Plain keys are also written as this profile, renewed while you're signed in.">+ {profile.name}-keys</div>
          )}
        </td>
        <td className="px-3 py-2">
          <RegionCell profileId={profile.id} region={profile.region} />
        </td>
        <td className="px-3 py-2">
          <StatusChip status={profile.status} compact={underPortal} />
        </td>
        <td className="py-2 pl-3 pr-4">
          <div className="flex items-center justify-end gap-1.5">
            {needsSignIn && portal && !underPortal && (
              <button className="btn-primary" onClick={() => open({ kind: 'sign-in', portalId: portal.id })}>
                <LogIn size={13} /> {live === 'expiring' ? 'Sign in again' : 'Sign in'}
              </button>
            )}
            {needsKeys && (
              <button className="btn-primary" onClick={() => open({ kind: 'paste', profileId: profile.id })}>
                <ClipboardPaste size={13} /> Paste new keys
              </button>
            )}
            <CopyButton text={exportLine} label="Use" title={`Copy "${exportLine}" for a terminal (or run: awspm use ${profile.name})`} />
            <Menu
              items={[
                ...(profile.kind === 'keys' ? [{ label: 'Paste new keys', icon: <ClipboardPaste size={13} />, onClick: () => open({ kind: 'paste', profileId: profile.id }) }] : []),
                { label: profile.kind === 'keys' ? 'Check keys now' : 'Refresh status', icon: <RefreshCw size={13} />, onClick: () => void run(() => api.checkProfile(profile.id), 'Checked.') },
                ...(profile.kind === 'sso'
                  ? [{
                      label: profile.sso?.exportKeys ? `Stop writing ${profile.name}-keys` : 'Also write plain keys',
                      icon: <KeyRound size={13} />,
                      onClick: () => void run(() => api.updateProfile({ id: profile.id, exportKeys: !profile.sso?.exportKeys }), 'Saved.'),
                    }]
                  : []),
                { label: 'Move to another project', icon: <FolderInput size={13} />, onClick: () => open({ kind: 'move', profileId: profile.id }), disabled: state.projects.length < 2 },
                { label: `Copy "awspm use ${profile.name}"`, icon: <Terminal size={13} />, onClick: () => void navigator.clipboard.writeText(`awspm use ${profile.name}`) },
                { label: 'Stop managing', icon: <Unlink size={13} />, onClick: () => confirmRemove(false) },
                { label: 'Delete from AWS files', icon: <Trash2 size={13} />, onClick: () => confirmRemove(true), danger: true },
              ]}
            />
          </div>
        </td>
      </tr>
      {(profile.conflicts.length > 0 || (profile.status.note && live !== 'active' && !underPortal)) && (
        <tr>
          <td colSpan={6} className="pb-2 pl-9 pr-4">
            {profile.status.note && live !== 'active' && !underPortal && <p className="text-[0.6875rem] text-muted">{profile.status.note}</p>}
            {profile.conflicts.length > 0 && <ConflictBanner profile={profile} />}
          </td>
        </tr>
      )}
    </>
  );
}

/** The account: its label (click to edit label and color, for every profile in it), name and number. */
function AccountCell({ accountId }: { accountId: string | null }) {
  const { state } = useApp();
  if (!accountId) return <span className="text-xs text-faint">Unknown account</span>;
  const account = state.accounts[accountId] ?? { name: null, label: '', color: null };
  return (
    <div className="flex items-center gap-2.5">
      <Popover title="Edit this account's label and color" trigger={<LabelTag label={account.label} color={account.color} />}>
        {close => <AccountEditor accountId={accountId} initialLabel={account.label} initialColor={account.color} onDone={close} />}
      </Popover>
      <span className="min-w-0">
        {account.name && <span className="block truncate text-[0.78125rem] text-text" title={account.name}>{account.name}</span>}
        <span className="block font-mono text-[0.6875rem] text-muted">{accountId}</span>
      </span>
    </div>
  );
}

function AccountEditor({ accountId, initialLabel, initialColor, onDone }: { accountId: string; initialLabel: string; initialColor: LabelColor | null; onDone: () => void }) {
  const { run } = useApp();
  const [label, setLabel] = useState(initialLabel);
  const [color, setColor] = useState(initialColor);
  const save = async () => {
    if (await run(() => api.updateAccount({ accountId, label, color }))) onDone();
  };
  return (
    <div className="space-y-3">
      <div>
        <label className="field-label" htmlFor={`label-${accountId}`}>Label for account {accountId}</label>
        <input
          id={`label-${accountId}`}
          autoFocus
          value={label}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && void save()}
          className="field h-8 text-xs"
          placeholder="Prod"
          maxLength={30}
        />
      </div>
      <ColorSwatches value={color} onChange={setColor} size="h-5 w-5" />
      <p className="text-[0.6875rem] text-muted">Shared by every profile in this account.</p>
      <div className="flex justify-end">
        <button className="btn-primary" onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}

/** The region, changed in place (it's written to the profile's config section). */
function RegionCell({ profileId, region }: { profileId: string; region: string }) {
  const { run } = useApp();
  const [value, setValue] = useState(region);
  return (
    <Popover
      title="Change the region"
      width="w-64"
      trigger={<span className="font-mono text-xs text-text underline decoration-faint decoration-dotted underline-offset-4">{region}</span>}
    >
      {close => (
        <div className="space-y-2">
          <RegionInput value={value} onChange={setValue} compact />
          <div className="flex justify-end">
            <button
              className="btn-primary"
              disabled={!value || value === region}
              onClick={async () => {
                if (await run(() => api.updateProfile({ id: profileId, region: value }), 'Region saved.')) close();
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function ConflictBanner({ profile }: { profile: Profile }) {
  const { run } = useApp();
  const credentials = profile.conflicts.some(c => c.file === 'credentials');
  const where = profile.conflicts.map(c => `[${c.section}] in ~/.aws/${c.file}`).join(' and ');
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-[0.6875rem] text-warning">
      <AlertTriangle size={13} className="shrink-0" />
      <span className="min-w-0 flex-1">
        {profile.missing ? `${profile.name} is no longer in your AWS files.` : `${where} changed outside AWS Profile Manager. The app won't overwrite it until you choose.`}
      </span>
      <button className="btn" onClick={() => void run(() => api.resolveConflict(profile.id, 'accept'), profile.missing ? 'Stopped managing it.' : "Using the file's version.")}>
        {profile.missing ? 'Stop managing it' : 'Use file version'}
      </button>
      {!credentials && (
        <button className="btn" onClick={() => void run(() => api.resolveConflict(profile.id, 'restore'), 'Restored.')}>
          Restore AWS Profile Manager's version
        </button>
      )}
    </div>
  );
}
