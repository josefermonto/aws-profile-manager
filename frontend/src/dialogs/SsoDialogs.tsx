import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, Loader2, Search } from 'lucide-react';
import { api, errorMessage } from '../api';
import { useApp, useLookups, type Dialog } from '../lib/appContext';
import { liveState } from '../lib/format';
import { guessColor, guessLabel, slug, suggestName } from '../lib/names';
import { ColorSwatches, ErrorText, Hint, Modal, Popover } from '../components/ui';
import { RegionInput } from '../components/RegionInput';
import { AwsLogo } from '../components/AwsLogo';
import { useSubmit } from './useSubmit';
import type { LabelColor, Portal, SignInStart } from '../types';

const PORTAL_URL_RE = /^https:\/\/[^/\s]+\.(awsapps\.com|app\.aws)(\/|$)/i;
const portalKey = (url: string) => url.trim().replace(/#.*$/, '').replace(/\/+$/, '');

export function PortalDialog({ portal, projectId: contextProject, then }: { portal?: Portal; projectId?: string; then?: 'add-sso' }) {
  const { state, close, open } = useApp();
  const withoutPortal = state.projects.find(p => !state.portals.some(x => x.projectId === p.id));
  const [projectId, setProjectId] = useState(portal ? portal.projectId ?? '' : contextProject ?? withoutPortal?.id ?? '');
  const [startUrl, setStartUrl] = useState(portal?.startUrl ?? '');
  const [region, setRegion] = useState(portal?.region ?? 'us-east-1');
  const [name, setName] = useState(portal?.name ?? '');
  const [nameTouched, setNameTouched] = useState(Boolean(portal));
  const [discovery, setDiscovery] = useState<'idle' | 'looking' | 'found' | 'unknown'>('idle');
  const { busy, error, submit } = useSubmit();

  // "<Project> SSO" until the name is edited; the portal's subdomain when it's not tied to a project.
  const url = portalKey(startUrl);
  const project = state.projects.find(p => p.id === projectId);
  const subdomain = /^https:\/\/([^./]+)\./i.exec(url)?.[1];
  const suggested = project ? `${project.name} SSO` : subdomain && !/^d-[0-9a-f]+$/i.test(subdomain) ? subdomain : 'SSO';
  const shownName = nameTouched ? name : suggested;
  const sessionName = (() => {
    const base = slug(shownName) || 'sso';
    let candidate = base;
    for (let i = 2; state.portals.some(p => p.sessionName === candidate); i += 1) candidate = `${base}-${i}`;
    return candidate;
  })();

  // The SSO region fills itself in from the portal once a portal URL is pasted.
  useEffect(() => {
    if (!PORTAL_URL_RE.test(url) || url === portal?.startUrl) {
      setDiscovery('idle');
      return;
    }
    let cancelled = false;
    setDiscovery('looking');
    const timer = setTimeout(() => {
      api.discoverRegion(url)
        .then(r => {
          if (cancelled) return;
          if (r.region) setRegion(r.region);
          setDiscovery(r.region ? 'found' : 'unknown');
        })
        .catch(() => !cancelled && setDiscovery('unknown'));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, portal?.startUrl]);

  const save = async () => {
    const r = await submit(() => api.savePortal({ id: portal?.id, name: shownName, projectId: projectId || null, startUrl: url, region }));
    if (!r) return;
    if (portal) close();
    else open({ kind: 'sign-in', portalId: r.id, then: then === 'add-sso' && projectId ? { kind: 'add-sso', projectId, portalId: r.id } : undefined });
  };

  return (
    <Modal
      title={portal ? 'Edit SSO portal' : 'Add an SSO portal'}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn-primary" disabled={!shownName.trim() || !PORTAL_URL_RE.test(url) || !region || busy} onClick={() => void save()}>
            {portal ? 'Save' : 'Save and sign in'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="field-label" htmlFor="portal-url">AWS access portal URL</label>
          <input id="portal-url" autoFocus value={startUrl} onChange={e => setStartUrl(e.target.value)} className="field font-mono" placeholder="https://my-company.awsapps.com/start" spellCheck={false} />
          <Hint>The page you get "command line credentials" from. Pasting it straight from the address bar, #/ and all, is fine.</Hint>
          {portal && url !== portal.startUrl && <Hint>Changing the URL or region signs you out of this portal.</Hint>}
        </div>
        <div className="grid grid-cols-[1fr_190px] gap-3">
          <div>
            <label className="field-label" htmlFor="portal-project">Project</label>
            <select id="portal-project" value={projectId} onChange={e => setProjectId(e.target.value)} className="field">
              {state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="">Shared by several projects</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="portal-region">SSO region</label>
            <RegionInput id="portal-region" value={region} onChange={setRegion} />
          </div>
        </div>
        {discovery === 'looking' && <p className="flex items-center gap-1.5 text-[0.6875rem] text-muted"><Loader2 size={11} className="animate-spin" /> Finding this portal's SSO region…</p>}
        {discovery === 'found' && <p className="flex items-center gap-1.5 text-[0.6875rem] text-success"><Check size={11} /> SSO region found from the portal: <span className="font-mono">{region}</span></p>}
        {discovery === 'unknown' && <p className="text-[0.6875rem] text-muted">Couldn't tell this portal's SSO region. Pick it from the list.</p>}
        <div>
          <label className="field-label" htmlFor="portal-name">Name</label>
          <input
            id="portal-name"
            value={shownName}
            onChange={e => { setName(e.target.value); setNameTouched(true); }}
            className="field"
          />
          <Hint>
            {portal ? 'Shown in the app and in notifications.' : <>Saved in ~/.aws/config as <code className="font-mono">[sso-session {sessionName}]</code>.</>}{' '}
            Time left counts from Identity Center's 8-hour default until your first sign-in ends; then the real length is used. AWS doesn't report it.
          </Hint>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

/**
 * The device sign-in: AWS's link and code. Open it here, or copy it into
 * another browser or an AWS WorkSpace; the service notices the approval
 * either way and saves the sign-in where the AWS CLI looks for it.
 */
export function SignInDialog({ portalId, then }: { portalId: string; then?: Dialog }) {
  const { close, open, toast, refresh } = useApp();
  const { portals } = useLookups();
  const portal = portals.get(portalId);
  const [flow, setFlow] = useState<SignInStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(-1);

  useEffect(() => {
    if (started.current === attempt) return;
    started.current = attempt;
    setError(null);
    setFlow(null);
    api.startSignIn(portalId).then(setFlow).catch(err => setError(errorMessage(err)));
  }, [portalId, attempt]);

  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let delay = Math.max(2, flow.interval) * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await api.pollSignIn(flow.flowId);
        if (cancelled) return;
        if (r.status === 'pending') {
          if (r.slowDown) delay += 5000;
          timer = setTimeout(tick, delay);
        } else if (r.status === 'done') {
          toast(`Signed in to ${portal?.name ?? 'the portal'}.`);
          await refresh();
          if (then) open(then);
          else close();
        } else {
          setError(r.status === 'denied' ? 'The sign-in was denied in the browser.' : 'The code expired before it was approved.');
          setFlow(null);
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    };
    timer = setTimeout(tick, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, portal?.name, then, open, close, toast, refresh]);

  const copy = async () => {
    if (!flow?.verificationUri) return;
    try {
      await navigator.clipboard.writeText(flow.verificationUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // the link is still selectable in the field
    }
  };

  return (
    <Modal title={`Sign in to ${portal?.name ?? 'portal'}`} onClose={close}>
      {!flow && !error && <p className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Asking AWS for a sign-in code…</p>}
      {error && (
        <div>
          <ErrorText>{error}</ErrorText>
          <button className="btn mt-3" onClick={() => setAttempt(a => a + 1)}>Try again</button>
        </div>
      )}
      {flow && (
        <div className="space-y-4 text-sm">
          <p className="text-xs text-muted">Open this link in any browser (this one, another one, or an AWS WorkSpace), sign in to AWS if asked, and approve the request.</p>
          {flow.userCode && (
            <div className="text-xs text-muted">
              Check that AWS shows this code:
              <div className="mt-1.5 inline-block rounded-md border border-border-strong bg-surface-alt px-3 py-1.5 font-mono text-lg font-semibold tracking-[0.2em] text-heading">{flow.userCode}</div>
            </div>
          )}
          {flow.verificationUri && (
            <div className="space-y-2">
              <input readOnly value={flow.verificationUri} onFocus={e => e.currentTarget.select()} aria-label="Sign-in link" className="field font-mono text-xs" />
              <div className="flex gap-2">
                <a href={flow.verificationUri} target="_blank" rel="noopener noreferrer" className="btn-primary"><ExternalLink size={13} /> Open in new tab</a>
                <button type="button" onClick={() => void copy()} className="btn">{copied ? <Check size={13} className="text-success" /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy link'}</button>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border pt-3 text-xs">
            <span className="flex items-center gap-2 text-muted"><Loader2 size={13} className="animate-spin text-primary" /> Waiting for your approval…</span>
            <button className="font-semibold text-muted hover:text-text" onClick={close}>Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

interface AccountPick {
  accountId: string;
  accountName: string;
  include: boolean;
  label: string;
  color: LabelColor | null;
  /** `existing`: managed profiles that already use this account and role (those aren't added again). */
  roles: { roleName: string; existing: string[]; on: boolean }[];
}

/**
 * Add accounts from an SSO portal, many at once: every account is pre-ticked
 * with every role it offers, a label guessed from its name and a color from
 * the label, all editable per account. Role toggles at the top switch a role
 * on or off for every account.
 */
export function AddSsoDialog({ projectId, portalId: initialPortal }: { projectId: string; portalId?: string }) {
  const { state, close, open, now, toast } = useApp();
  const project = state.projects.find(p => p.id === projectId);
  const [portalId, setPortalId] = useState(initialPortal ?? state.portals.find(p => p.projectId === projectId)?.id ?? state.portals[0]?.id ?? '');
  const portal = state.portals.find(p => p.id === portalId);
  const signedIn = portal ? ['active', 'expiring'].includes(liveState(portal.status, now, state.settings.warnMinutes)) : false;
  const [picks, setPicks] = useState<AccountPick[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [region, setRegion] = useState(() => {
    const regions = state.profiles.filter(p => p.projectId === projectId).map(p => p.region);
    return regions.sort((a, b) => regions.filter(r => r === b).length - regions.filter(r => r === a).length)[0] ?? 'us-east-1';
  });
  const [exportKeys, setExportKeys] = useState(false);
  const { busy, error, submit } = useSubmit();

  useEffect(() => {
    setPicks(null);
    setLoadError(null);
    if (!portalId || !signedIn) return;
    let cancelled = false;
    api.listAccounts(portalId)
      .then(r => {
        if (cancelled) return;
        setPicks(r.accounts.map(a => {
          const known = state.accounts[a.accountId];
          const label = known?.label || guessLabel(a.accountName, project?.name ?? '');
          const roles = a.roles.map(role => ({ roleName: role.roleName, existing: role.profiles, on: role.profiles.length === 0 }));
          return {
            accountId: a.accountId,
            accountName: a.accountName,
            include: roles.some(r => r.on),
            label,
            color: known?.label ? known.color : guessColor(label),
            roles,
          };
        }));
      })
      .catch(err => !cancelled && setLoadError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portalId, signedIn]);

  const update = (accountId: string, change: (p: AccountPick) => AccountPick) =>
    setPicks(list => list?.map(p => (p.accountId === accountId ? change(p) : p)) ?? null);

  // Every role offered by any account, with how many accounts it would be added to.
  const roleNames = useMemo(() => [...new Set((picks ?? []).flatMap(p => p.roles.map(r => r.roleName)))].sort(), [picks]);
  const roleOn = (roleName: string) =>
    (picks ?? []).every(p => !p.include || p.roles.every(r => r.roleName !== roleName || r.existing.length > 0 || r.on));
  const toggleRole = (roleName: string) => {
    const on = !roleOn(roleName);
    setPicks(list => list?.map(p => ({ ...p, roles: p.roles.map(r => (r.roleName === roleName && !r.existing.length ? { ...r, on } : r)) })) ?? null);
  };

  // The profile names that will be created: <project>-<label>-<role>, made unique.
  const names = useMemo(() => {
    const taken = new Set([...state.profiles.map(p => p.name), ...state.unmanaged.map(p => p.name)]);
    const out = new Map<string, string>();
    for (const p of picks ?? []) {
      if (!p.include) continue;
      for (const r of p.roles) {
        if (!r.on || r.existing.length) continue;
        let name = suggestName(project?.name ?? '', p.label || p.accountName, r.roleName);
        if (taken.has(name)) name = `${name}-${p.accountId.slice(-4)}`;
        for (let i = 2; taken.has(name); i += 1) name = `${name}-${i}`;
        taken.add(name);
        out.set(`${p.accountId}/${r.roleName}`, name);
      }
    }
    return out;
  }, [picks, state.profiles, state.unmanaged, project?.name]);

  const selected = (picks ?? []).filter(p => p.include && p.roles.some(r => r.on && !r.existing.length));
  const shown = (picks ?? []).filter(p => {
    const needle = filter.trim().toLowerCase();
    return !needle || p.accountName.toLowerCase().includes(needle) || p.accountId.includes(needle) || p.label.toLowerCase().includes(needle);
  });

  const create = async () => {
    const accounts = selected.map(p => ({
      accountId: p.accountId,
      accountName: p.accountName,
      label: p.label,
      color: p.color,
      roles: p.roles.filter(r => r.on && !r.existing.length).map(r => ({ roleName: r.roleName, name: names.get(`${p.accountId}/${r.roleName}`)! })),
    }));
    const r = await submit(() => api.createSsoProfiles({ portalId, projectId, region, exportKeys, accounts }));
    if (r) {
      toast(`Added ${r.ids.length} profile${r.ids.length === 1 ? '' : 's'} from ${accounts.length} account${accounts.length === 1 ? '' : 's'}.`);
      close();
    }
  };

  return (
    <Modal
      size="xl"
      title={<>Add SSO accounts to {project?.name}</>}
      onClose={close}
      footer={
        <>
          <span className="mr-auto text-xs text-muted">{names.size ? `${names.size} profile${names.size === 1 ? '' : 's'} from ${selected.length} account${selected.length === 1 ? '' : 's'}` : 'Nothing selected'}</span>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn-primary" disabled={!names.size || busy} onClick={() => void create()}>
            {busy && <Loader2 size={13} className="animate-spin" />} Add {names.size || ''} profile{names.size === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="field-label" htmlFor="sso-portal">Portal</label>
            <select id="sso-portal" value={portalId} onChange={e => setPortalId(e.target.value)} className="field">
              {state.portals.map(p => <option key={p.id} value={p.id}>{p.name} · {p.startUrl.replace(/^https:\/\//, '')}</option>)}
            </select>
          </div>
          <button className="btn h-9" onClick={() => open({ kind: 'portal', projectId, then: 'add-sso' })}>New portal</button>
        </div>

        {portal && !signedIn && (
          <div className="rounded-lg border border-border bg-surface-alt px-4 py-3 text-sm">
            <p>Sign in to {portal.name} to see its accounts and roles.</p>
            <button className="btn-primary mt-2" onClick={() => open({ kind: 'sign-in', portalId, then: { kind: 'add-sso', projectId, portalId } })}>
              <KeyRound size={13} /> Sign in
            </button>
          </div>
        )}
        {signedIn && !picks && !loadError && <p className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> Loading accounts and roles…</p>}
        <ErrorText>{loadError}</ErrorText>

        {picks && picks.length === 0 && <p className="text-sm text-muted">This sign-in has no accounts.</p>}
        {picks && picks.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-text">Roles for every account:</span>
              {roleNames.map(roleName => {
                const on = roleOn(roleName);
                return (
                  <button
                    key={roleName}
                    type="button"
                    onClick={() => toggleRole(roleName)}
                    className={`flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-semibold transition-colors ${on ? 'border-primary bg-primary text-on-primary' : 'border-border-strong bg-surface text-muted hover:text-text'}`}
                  >
                    {on && <Check size={10} />} {roleName}
                  </button>
                );
              })}
              {picks.length > 8 && (
                <div className="relative ml-auto w-56">
                  <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                  <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter accounts" className="field h-8 pl-7 text-xs" />
                </div>
              )}
            </div>

            <div className="max-h-[48vh] overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 z-10 bg-surface-alt text-[0.6875rem] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="All accounts"
                        checked={picks.every(p => p.include)}
                        onChange={e => setPicks(list => list?.map(p => ({ ...p, include: e.target.checked })) ?? null)}
                      />
                    </th>
                    <th className="px-2 py-2">Account</th>
                    <th className="w-40 px-2 py-2">Label</th>
                    <th className="w-16 px-2 py-2">Color</th>
                    <th className="px-2 py-2">Roles → profiles</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(p => (
                    <tr key={p.accountId} className={`border-t border-border align-top ${p.include ? '' : 'opacity-50'}`}>
                      <td className="px-3 py-2">
                        <input type="checkbox" aria-label={`Add ${p.accountName}`} checked={p.include} onChange={e => update(p.accountId, x => ({ ...x, include: e.target.checked }))} />
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          <AwsLogo size={18} />
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-heading" title={p.accountName}>{p.accountName}</span>
                            <span className="block font-mono text-[0.6875rem] text-muted">{p.accountId}</span>
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          value={p.label}
                          onChange={e => update(p.accountId, x => ({ ...x, label: e.target.value }))}
                          className="field h-7 text-xs"
                          maxLength={30}
                          aria-label={`Label for ${p.accountName}`}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Popover
                          title="Color"
                          width="w-60"
                          trigger={<span className="block h-6 w-6 rounded-full border border-border" style={p.color ? { background: `var(--env-${p.color})` } : undefined} />}
                        >
                          {done => <ColorSwatches value={p.color} onChange={c => { update(p.accountId, x => ({ ...x, color: c })); done(); }} size="h-5 w-5" />}
                        </Popover>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-wrap gap-1.5">
                          {p.roles.map(r => {
                            const existing = r.existing.length > 0;
                            const name = names.get(`${p.accountId}/${r.roleName}`);
                            return (
                              <button
                                key={r.roleName}
                                type="button"
                                disabled={existing || !p.include}
                                title={existing ? `Already set up as ${r.existing.join(', ')}` : name ? `Creates ${name}` : undefined}
                                onClick={() => update(p.accountId, x => ({ ...x, roles: x.roles.map(y => (y.roleName === r.roleName ? { ...y, on: !y.on } : y)) }))}
                                className={`rounded-full border px-2 py-0.5 text-[0.6875rem] font-semibold transition-colors disabled:cursor-default ${
                                  existing ? 'border-border bg-surface-alt text-faint' : r.on ? 'border-primary bg-primary-soft text-primary-soft-text' : 'border-border-strong bg-surface text-muted line-through'
                                }`}
                              >
                                {r.roleName}{existing && ' · added'}
                              </button>
                            );
                          })}
                        </div>
                        {p.include && p.roles.some(r => names.has(`${p.accountId}/${r.roleName}`)) && (
                          <div className="mt-1 font-mono text-[0.65625rem] text-muted">
                            {p.roles.map(r => names.get(`${p.accountId}/${r.roleName}`)).filter(Boolean).join(', ')}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-start gap-6">
              <div className="w-48">
                <label className="field-label" htmlFor="sso-region">Region for these profiles</label>
                <RegionInput id="sso-region" value={region} onChange={setRegion} compact />
              </div>
              <label className="mt-6 flex max-w-md items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={exportKeys} onChange={e => setExportKeys(e.target.checked)} />
                <span>
                  Also write plain keys (as <code className="font-mono">&lt;name&gt;-keys</code>)
                  <Hint>Only for tools that can't read SSO profiles and need ~/.aws/credentials. Renewed while you're signed in.</Hint>
                </span>
              </label>
            </div>
          </>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
