import { useEffect, useState } from 'react';
import { Clock, Loader2, ShieldCheck } from 'lucide-react';
import { timeOfDay } from '../lib/format';
import { api } from '../api';
import { useApp } from '../lib/appContext';
import { NAME_RE, NAME_RULE, guessColor, portalHeader, suggestName } from '../lib/names';
import { ColorSwatches, ErrorText, Hint, Modal, ProjectSelect } from '../components/ui';
import { RegionInput } from '../components/RegionInput';
import { useSubmit } from './useSubmit';
import type { LabelColor } from '../types';

/**
 * Paste credentials from the access portal (any of its formats): a new profile
 * in a project, or new keys for an existing one. The keys are checked with AWS
 * STS before anything is written, go straight to ~/.aws/credentials, and their
 * expiry is worked out on the server.
 */
export function PasteDialog({ projectId: initialProject, profileId }: { projectId?: string; profileId?: string }) {
  const { state, close, toast } = useApp();
  const existing = profileId ? state.profiles.find(p => p.id === profileId) : undefined;
  const [projectId, setProjectId] = useState(initialProject ?? state.projects[0]?.id ?? '');
  const project = state.projects.find(p => p.id === projectId);
  const [blob, setBlob] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [accountLabel, setAccountLabel] = useState('');
  const [labelTouched, setLabelTouched] = useState(false);
  const [color, setColor] = useState<LabelColor | null>(null);
  const [colorTouched, setColorTouched] = useState(false);
  const [region, setRegion] = useState('us-east-1');
  const { busy, error, submit } = useSubmit();

  // The portal's block names the account; an account seen before brings its label and color.
  const header = portalHeader(blob);
  const known = header ? state.accounts[header.accountId] : undefined;
  useEffect(() => {
    if (labelTouched) return;
    setAccountLabel(known?.label ?? '');
    if (!colorTouched) setColor(known?.color ?? null);
  }, [known?.label, known?.color, labelTouched, colorTouched]);
  useEffect(() => {
    if (existing || nameTouched || !project) return;
    setName(suggestName(project.name, accountLabel || header?.accountId.slice(-4) || '', header?.roleName || 'keys'));
  }, [existing, nameTouched, project, accountLabel, header?.roleName, header?.accountId]);

  const taken = !existing && (state.profiles.some(p => p.name === name) || state.unmanaged.some(p => p.name === name));
  const nameOk = existing || (NAME_RE.test(name) && !taken);
  const save = async () => {
    const r = await submit(() =>
      api.pasteCredentials({
        ...(existing
          ? { profileId: existing.id }
          : { projectId, name, region, ...(accountLabel ? { accountLabel, accountColor: color } : {}) }),
        blob,
      }),
    );
    if (!r) return;
    const lasts = r.lifetimeMs ? (r.lifetimeMs % 3600e3 === 0 ? `${r.lifetimeMs / 3600e3} h` : `${Math.round(r.lifetimeMs / 60000)} min`) : null;
    const expiry = !r.expiresAt
      ? ' No expiry: long-lived keys.'
      : r.expiryBasis === 'role'
        ? ` Expires at ${timeOfDay(r.expiresAt)}: the role's sessions last ${lasts}.`
        : r.expiryBasis === 'learned'
          ? ` Expires around ${timeOfDay(r.expiresAt)}: this role's keys lasted ${lasts} last time.`
          : ` Expires around ${timeOfDay(r.expiresAt)} (the ${lasts} AWS default); corrected when AWS reports them expired.`;
    toast(`${existing ? 'New keys saved for' : 'Created'} ${existing?.name ?? name}${r.principal ? ` (${r.principal} in ${r.accountId})` : ''}.${expiry}`);
    for (const w of r.warnings) toast(w, 'info');
    close();
  };

  return (
    <Modal
      title={existing ? <>New keys for <span className="font-mono">{existing.name}</span></> : 'Paste keys'}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn-primary" disabled={!blob.trim() || busy || (!existing && (!projectId || !nameOk))} onClick={() => void save()}>
            {busy && <Loader2 size={13} className="animate-spin" />} Check and save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="field-label" htmlFor="paste-blob">Credentials</label>
          <textarea
            id="paste-blob"
            autoFocus
            value={blob}
            onChange={e => setBlob(e.target.value)}
            rows={6}
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-[0.6875rem] text-text placeholder-muted focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
            placeholder={'[111122223333_AdministratorAccess]\naws_access_key_id=ASIA…\naws_secret_access_key=…\naws_session_token=…'}
          />
          <Hint>Any form the access portal offers: the credentials-file block, or the macOS/Linux, Windows or PowerShell environment variables.</Hint>
          {header && <p className="mt-1 text-[0.6875rem] text-success">Account {header.accountId}, role {header.roleName}.</p>}
        </div>

        {!existing && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label" htmlFor="paste-project">Project</label>
                <ProjectSelect id="paste-project" value={projectId} onChange={setProjectId} />
              </div>
              <div>
                <label className="field-label" htmlFor="paste-region">Region</label>
                <RegionInput id="paste-region" value={region} onChange={setRegion} />
              </div>
            </div>
            <div>
              <label className="field-label" htmlFor="paste-label">Account label</label>
              <div className="flex items-center gap-3">
                <input
                  id="paste-label"
                  value={accountLabel}
                  onChange={e => {
                    setAccountLabel(e.target.value);
                    setLabelTouched(true);
                    if (!colorTouched) setColor(guessColor(e.target.value));
                  }}
                  className="field w-40"
                  placeholder="Prod"
                  maxLength={30}
                />
                <ColorSwatches value={color} onChange={c => { setColor(c); setColorTouched(true); }} size="h-5 w-5" />
              </div>
              <Hint>Shared by every profile in this AWS account. {known?.label ? 'Already set for this account.' : 'The account is identified when the keys are checked.'}</Hint>
            </div>
            <div>
              <label className="field-label" htmlFor="paste-name">Profile name</label>
              <input id="paste-name" value={name} onChange={e => { setName(e.target.value); setNameTouched(true); }} className={`field font-mono text-xs ${name && !nameOk ? 'border-danger' : ''}`} spellCheck={false} />
              {name && !nameOk && <p className="mt-1 text-[0.6875rem] text-danger">{taken ? 'A profile with this name already exists.' : NAME_RULE}</p>}
            </div>
          </>
        )}

        <div className="space-y-1.5 text-[0.6875rem] text-muted">
          <p className="flex items-start gap-1.5">
            <ShieldCheck size={13} className="mt-px shrink-0 text-success" />
            Checked with AWS STS first (no permissions needed). The keys are written only to ~/.aws/credentials and never shown again.
          </p>
          <p className="flex items-start gap-1.5">
            <Clock size={13} className="mt-px shrink-0 text-primary" />
            When they expire is worked out for you: from the role's session length for keys from an SSO portal, otherwise from how long
            this role's keys lasted before, or the AWS default. AWS is checked every few minutes, every minute near the end.
          </p>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
