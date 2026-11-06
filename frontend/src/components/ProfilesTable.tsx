import { useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardPaste, FolderPlus, Inbox, KeyRound, LogIn, LogOut, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../lib/appContext';
import { liveState, timeOfDay } from '../lib/format';
import type { Portal, Profile, Project, UnmanagedProfile } from '../types';
import { AwsLogo } from './AwsLogo';
import { ProfileRow } from './ProfileRow';
import { Menu, Popover, ProjectSelect, StatusChip } from './ui';

const ADOPTABLE = new Set(['keys', 'sso']);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The whole app on one page: getting-started steps, a search box, and one
 * table of every profile, grouped by project (each group shows its SSO
 * sign-in), plus the profiles in ~/.aws that aren't managed yet.
 */
export function ProfilesTable() {
  const { state, open } = useApp();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set(['unmanaged']));
  const unmanagedRef = useRef<HTMLTableSectionElement>(null);

  const toggle = (key: string) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const needle = query.trim().toLowerCase();
  const matches = (p: Profile, project: Project) => {
    if (!needle) return true;
    const account = p.accountId ? state.accounts[p.accountId] : undefined;
    return [p.name, p.label, p.region, p.accountId, account?.name, account?.label, project.name].some(v => v?.toLowerCase().includes(needle));
  };

  const groups = useMemo(
    () =>
      [...state.projects]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(project => ({
          project,
          portals: state.portals.filter(p => p.projectId === project.id),
          profiles: state.profiles
            .filter(p => p.projectId === project.id && matches(p, project))
            .sort((a, b) => {
              const la = (a.accountId && state.accounts[a.accountId]?.label) || '￿';
              const lb = (b.accountId && state.accounts[b.accountId]?.label) || '￿';
              return la.localeCompare(lb) || (a.accountId ?? '').localeCompare(b.accountId ?? '') || a.label.localeCompare(b.label);
            }),
        }))
        .filter(g => !needle || g.profiles.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, needle],
  );
  const sharedPortals = state.portals.filter(p => !p.projectId);
  const unmanaged = state.unmanaged.filter(p => !needle || p.name.toLowerCase().includes(needle));

  const showUnmanaged = () => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.delete('unmanaged');
      return next;
    });
    setTimeout(() => unmanagedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-6 py-5">
      <GettingStarted onReviewUnmanaged={showUnmanaged} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search profiles, accounts, labels, roles…" className="field pl-8" />
        </div>
        <button className="btn" onClick={() => open({ kind: 'project' })}><FolderPlus size={13} /> New project</button>
        <button className="btn" onClick={() => open({ kind: 'portal', then: 'add-sso' })}><KeyRound size={13} /> Add SSO portal</button>
        <button className="btn-primary" onClick={() => open({ kind: 'paste' })} disabled={!state.projects.length}><ClipboardPaste size={13} /> Paste keys</button>
      </div>

      {sharedPortals.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">Shared SSO portals</span>
          {sharedPortals.map(p => <PortalStatus key={p.id} portal={p} />)}
        </div>
      )}

      <div className="card overflow-visible">
        <table className="w-full table-fixed text-left">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[16%]" />
            <col className="w-[28%]" />
            <col className="w-[9%]" />
            <col className="w-[13%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead className="border-b border-border bg-surface-alt text-[0.6875rem] uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2 pl-9 pr-3 font-semibold">Account</th>
              <th className="px-3 py-2 font-semibold">Role</th>
              <th className="px-3 py-2 font-semibold">Profile</th>
              <th className="px-3 py-2 font-semibold">Region</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="py-2 pl-3 pr-4" />
            </tr>
          </thead>
          {groups.map(g => (
            <ProjectGroup key={g.project.id} project={g.project} portals={g.portals} profiles={g.profiles} collapsed={collapsed.has(g.project.id)} onToggle={() => toggle(g.project.id)} />
          ))}
          {state.projects.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={6} className="px-6 py-10 text-center text-sm text-muted">
                  Start with a project for each client, then add its SSO portal or paste keys.
                  <div className="mt-3">
                    <button className="btn-primary" onClick={() => open({ kind: 'project' })}><FolderPlus size={13} /> New project</button>
                  </div>
                </td>
              </tr>
            </tbody>
          )}
          {needle && groups.length === 0 && (
            <tbody>
              <tr><td colSpan={6} className="px-6 py-8 text-center text-sm text-muted">No profiles match "{query}".</td></tr>
            </tbody>
          )}
          {unmanaged.length > 0 && (
            <UnmanagedGroup innerRef={unmanagedRef} profiles={unmanaged} collapsed={collapsed.has('unmanaged')} onToggle={() => toggle('unmanaged')} />
          )}
        </table>
      </div>
    </div>
  );
}

function GroupHeader({ collapsed, onToggle, children }: { collapsed: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <tr className="border-t border-border-strong/60 bg-surface-alt">
      <td colSpan={6} className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button onClick={onToggle} className="btn-ghost -ml-1 px-1" aria-label={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
          {children}
        </div>
      </td>
    </tr>
  );
}

function ProjectGroup({ project, portals, profiles, collapsed, onToggle }: { project: Project; portals: Portal[]; profiles: Profile[]; collapsed: boolean; onToggle: () => void }) {
  const { state, open } = useApp();
  const addSso = () => open(portals.length ? { kind: 'add-sso', projectId: project.id, portalId: portals[0].id } : { kind: 'portal', projectId: project.id, then: 'add-sso' });
  const accounts = new Set(profiles.map(p => p.accountId).filter(Boolean)).size;
  const confirmDelete = () => {
    const names = state.profiles.filter(p => p.projectId === project.id).map(p => p.name);
    open({
      kind: 'confirm',
      title: `Delete ${project.name}?`,
      body: (
        <>
          Deletes {project.name} and its {plural(names.length, 'profile')}.
          {names.length > 0 && (
            <span className="mt-2 flex flex-wrap gap-1.5">{names.map(n => <span key={n} className="rounded bg-surface-alt px-2 py-0.5 font-mono text-[0.6875rem]">{n}</span>)}</span>
          )}
        </>
      ),
      option: names.length || portals.length
        ? {
            defaultChecked: true,
            label: (
              <>
                Also remove {names.length === 1 ? 'it' : 'them'} from <code className="font-mono">~/.aws/config</code> and <code className="font-mono">~/.aws/credentials</code>
                {portals.length > 0 && <>, with {portals.map(p => p.name).join(', ')} and its sign-in (unless another project still uses it)</>}.
                <span className="block text-xs text-muted">A backup of each file is kept first. Unchecked, your AWS files aren't touched and the profiles show up as unmanaged.</span>
              </>
            ),
          }
        : undefined,
      confirmLabel: 'Delete project',
      danger: true,
      onConfirm: deleteFromFiles => api.deleteProject(project.id, deleteFromFiles),
    });
  };

  return (
    <tbody>
      <GroupHeader collapsed={collapsed} onToggle={onToggle}>
        <span className="text-sm font-semibold text-heading">{project.name}</span>
        <span className="text-[0.6875rem] text-muted">{plural(profiles.length, 'profile')} · {plural(accounts, 'account')}</span>
        {portals.map(p => <PortalStatus key={p.id} portal={p} />)}
        <span className="ml-auto flex items-center gap-1.5">
          <button className="btn" onClick={addSso}><KeyRound size={13} /> {portals.length ? 'Add SSO accounts' : 'Add SSO portal'}</button>
          <button className="btn" onClick={() => open({ kind: 'paste', projectId: project.id })}><ClipboardPaste size={13} /> Paste keys</button>
          <Menu
            items={[
              { label: 'Rename project', icon: <Pencil size={13} />, onClick: () => open({ kind: 'project', project }) },
              { label: 'Add another SSO portal', icon: <Plus size={13} />, onClick: () => open({ kind: 'portal', projectId: project.id, then: 'add-sso' }) },
              { label: 'Delete project', icon: <Trash2 size={13} />, onClick: confirmDelete, danger: true },
            ]}
          />
        </span>
      </GroupHeader>
      {!collapsed && profiles.map(p => <ProfileRow key={p.id} profile={p} portalShown={portals.some(x => x.id === p.sso?.portalId)} />)}
      {!collapsed && profiles.length === 0 && (
        <tr className="border-t border-border">
          <td colSpan={6} className="py-3 pl-9 pr-4 text-xs text-muted">
            No profiles yet. {portals.length ? 'Add its SSO accounts, or paste keys.' : 'Add its SSO portal to pick accounts and roles, or paste keys.'}
          </td>
        </tr>
      )}
    </tbody>
  );
}

/** A portal's sign-in, compact: name, status with time left, and Sign in / Sign in again. */
function PortalStatus({ portal }: { portal: Portal }) {
  const { open, run, now, state } = useApp();
  const live = liveState(portal.status, now, state.settings.warnMinutes);
  const signedIn = live === 'active' || live === 'expiring';
  const length = portal.sessionMs ? `${Math.round(portal.sessionMs / 3600e3)} h (detected)` : '8 h (default)';
  return (
    <span className="flex items-center gap-2 rounded-full border border-border bg-surface py-0.5 pl-1 pr-1">
      <AwsLogo size={18} />
      <span
        className="text-xs font-semibold text-text"
        title={`${portal.startUrl}\nSSO region ${portal.region} · session length ${length}${portal.status.signedInAt && signedIn ? `\nSigned in at ${timeOfDay(portal.status.signedInAt)}` : ''}`}
      >
        {portal.name}
      </span>
      <StatusChip status={portal.status} />
      <button
        className={live === 'active' ? 'btn-ghost px-1.5 py-0.5' : 'btn-primary px-2 py-0.5'}
        onClick={() => open({ kind: 'sign-in', portalId: portal.id })}
        title={live === 'active' ? 'Sign in again' : 'Sign in'}
      >
        <LogIn size={12} /> {live === 'active' ? '' : live === 'expiring' ? 'Sign in again' : 'Sign in'}
      </button>
      <Menu
        items={[
          { label: 'Edit portal', icon: <Pencil size={13} />, onClick: () => open({ kind: 'portal', portal }) },
          { label: 'Sign out', icon: <LogOut size={13} />, disabled: !signedIn, onClick: () => void run(() => api.signOut(portal.id), `Signed out of ${portal.name}.`) },
          {
            label: 'Delete portal',
            icon: <Trash2 size={13} />,
            danger: true,
            onClick: () =>
              open({
                kind: 'confirm',
                title: `Delete ${portal.name}?`,
                body: <>Signs out and removes <code className="font-mono">[sso-session {portal.sessionName}]</code> from <code>~/.aws/config</code>. Portals with profiles must be emptied first.</>,
                confirmLabel: 'Delete portal',
                danger: true,
                onConfirm: () => api.deletePortal(portal.id),
              }),
          },
        ]}
      />
    </span>
  );
}

const KIND_TEXT: Record<UnmanagedProfile['kind'], string> = {
  keys: 'Keys',
  sso: 'SSO',
  'sso-legacy': 'Legacy SSO (no sso-session): recreate it from a portal',
  'assume-role': 'Assume-role: not supported yet',
  process: 'credential_process: not supported yet',
  other: 'Settings only, no credentials',
};

function UnmanagedGroup({ profiles, collapsed, onToggle, innerRef }: { profiles: UnmanagedProfile[]; collapsed: boolean; onToggle: () => void; innerRef: React.Ref<HTMLTableSectionElement> }) {
  const { state, run } = useApp();
  const adoptable = profiles.filter(p => ADOPTABLE.has(p.kind));
  return (
    <tbody ref={innerRef}>
      <GroupHeader collapsed={collapsed} onToggle={onToggle}>
        <Inbox size={14} className="text-muted" />
        <span className="text-sm font-semibold text-heading">Unmanaged in ~/.aws</span>
        <span className="text-[0.6875rem] text-muted">{plural(profiles.length, 'profile')} the app doesn't touch unless you adopt them</span>
        {adoptable.length > 0 && state.projects.length > 0 && (
          <span className="ml-auto">
            <AdoptPopover
              label={`Adopt all ${adoptable.length}`}
              onAdopt={projectId => run(() => api.adoptProfiles(adoptable.map(p => ({ name: p.name, projectId }))), `Adopted ${plural(adoptable.length, 'profile')}.`)}
            />
          </span>
        )}
      </GroupHeader>
      {!collapsed &&
        profiles.map(p => {
          const canAdopt = ADOPTABLE.has(p.kind);
          return (
            <tr key={p.name} className="border-t border-border align-top">
              <td className="py-2 pl-9 pr-3">
                {p.accountId ? <span className="font-mono text-[0.6875rem] text-muted">{p.accountId}</span> : p.keyId ? <span className="font-mono text-[0.6875rem] text-muted">{p.keyId}</span> : <span className="text-[0.6875rem] text-faint">—</span>}
              </td>
              <td className={`px-3 py-2 text-xs ${canAdopt ? 'text-text' : 'text-muted'}`}>
                {p.kind === 'keys' ? (p.temporary ? 'Temporary keys' : 'Long-lived keys') : p.roleName ?? KIND_TEXT[p.kind]}
              </td>
              <td className="px-3 py-2">
                <span className="font-mono text-[0.78125rem] text-text">{p.name}</span>
                {p.warnings.map(w => (
                  <p key={w} className="mt-1 flex items-start gap-1 text-[0.6875rem] text-warning">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {w} Adopting fixes it.
                  </p>
                ))}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-muted">{p.region ?? '—'}</td>
              <td className="px-3 py-2 text-[0.6875rem] text-muted">{canAdopt ? 'Unmanaged' : KIND_TEXT[p.kind]}</td>
              <td className="py-2 pl-3 pr-4 text-right">
                {canAdopt && state.projects.length > 0 && (
                  <AdoptPopover label="Adopt" onAdopt={projectId => run(() => api.adoptProfiles([{ name: p.name, projectId }]), `Adopted ${p.name}.`)} />
                )}
              </td>
            </tr>
          );
        })}
    </tbody>
  );
}

/** Pick the project to adopt into; with a single project, one click. */
function AdoptPopover({ label, onAdopt }: { label: string; onAdopt: (projectId: string) => Promise<boolean> }) {
  const { state } = useApp();
  const [projectId, setProjectId] = useState(state.projects[0]?.id ?? '');
  return (
    <Popover align="right" width="w-64" trigger={<span className="btn">{label}</span>}>
      {close => (
        <div className="space-y-2">
          <label className="field-label">Into project</label>
          <ProjectSelect value={projectId} onChange={setProjectId} />
          <p className="text-[0.6875rem] text-muted">Names and keys stay the same. A config section written as [name] becomes [profile name]. Each file is backed up first.</p>
          <div className="flex justify-end">
            <button className="btn-primary" disabled={!projectId} onClick={async () => { if (await onAdopt(projectId)) close(); }}>{label}</button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/** The three getting-started steps, always shown, each ticked once done. */
function GettingStarted({ onReviewUnmanaged }: { onReviewUnmanaged: () => void }) {
  const { state, open } = useApp();
  const adoptable = state.unmanaged.filter(p => ADOPTABLE.has(p.kind)).length;
  const steps = [
    {
      done: state.projects.length > 0,
      title: 'Create a project',
      text: state.projects.length ? plural(state.projects.length, 'project') : 'One per client',
      action: <button className="btn" onClick={() => open({ kind: 'project' })}><FolderPlus size={13} /> New project</button>,
    },
    {
      done: state.portals.length > 0,
      title: 'Add an SSO portal',
      text: state.portals.length ? plural(state.portals.length, 'portal') : 'Sign in once for all accounts',
      action: <button className="btn" onClick={() => open({ kind: 'portal', then: 'add-sso' })}><KeyRound size={13} /> Add portal</button>,
    },
    {
      done: adoptable === 0,
      title: 'Adopt existing profiles',
      text: adoptable ? `${adoptable} in ~/.aws not managed yet` : 'All managed',
      action: <button className="btn" onClick={onReviewUnmanaged}><Inbox size={13} /> {adoptable ? 'Review' : 'View'}</button>,
    },
  ];
  return (
    <section className="flex flex-wrap items-stretch gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center gap-2.5 pr-2">
        <AwsLogo size={28} />
        <span className="text-sm font-semibold leading-tight text-heading">Welcome to<br />AWS Profile Manager</span>
      </div>
      {steps.map((s, i) => (
        <div key={s.title} className="flex min-w-[220px] flex-1 items-center gap-3 rounded-md border border-border bg-surface-alt px-3 py-2">
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${s.done ? 'bg-success text-white' : 'bg-primary text-on-primary'}`}>
            {s.done ? <Check size={13} strokeWidth={3} /> : i + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[0.8125rem] font-semibold text-heading">{s.title}</span>
            <span className="block truncate text-[0.6875rem] text-muted">{s.text}</span>
          </span>
          {s.action}
        </div>
      ))}
    </section>
  );
}
