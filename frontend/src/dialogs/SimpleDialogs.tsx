import { useState, type ReactNode } from 'react';
import { ChevronRight, ClipboardPaste, Folder, KeyRound, Loader2, Plus, X } from 'lucide-react';
import { api } from '../api';
import { useApp, type Dialog } from '../lib/appContext';
import { ErrorText, Hint, Modal, ProjectSelect } from '../components/ui';
import { useSubmit } from './useSubmit';
import type { Project } from '../types';

export function ProjectDialog({ project }: { project?: Project }) {
  const { close, open } = useApp();
  const [name, setName] = useState(project?.name ?? '');
  const { busy, error, submit } = useSubmit();
  const save = async () => {
    if (project) {
      if ((await submit(() => api.updateProject(project.id, name))) !== undefined) close();
      return;
    }
    // A new project goes straight on to its first profiles.
    const created = await submit(() => api.createProject(name));
    if (created) open({ kind: 'next', projectId: created.id });
  };
  return (
    <Modal
      title={project ? 'Rename project' : 'New project'}
      onClose={close}
      footer={<><button className="btn" onClick={close}>Cancel</button><button className="btn-primary" disabled={!name.trim() || busy} onClick={() => void save()}>{project ? 'Save' : 'Create project'}</button></>}
    >
      <label className="field-label" htmlFor="project-name">Project or client name</label>
      <input id="project-name" autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && void save()} className="field" placeholder="Acme" />
      <Hint>Used in suggested profile names (acme-prod-admin) and the terminal prompt tag.</Hint>
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

/** Right after a project is created: how to add its profiles. */
export function NextStepDialog({ projectId }: { projectId: string }) {
  const { state, open, close } = useApp();
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return null;
  return (
    <Modal title={`${project.name} created`} onClose={close} footer={<button className="btn" onClick={close}>Later</button>}>
      <p className="mb-3 text-sm text-muted">How do you want to add its profiles?</p>
      <div className="space-y-2">
        <Choice
          icon={<KeyRound size={18} />}
          title="Sign in with SSO"
          text={`Add ${project.name}'s access portal URL, sign in once, and add all its accounts and roles in one go.`}
          recommended
          onClick={() => open({ kind: 'portal', projectId, then: 'add-sso' })}
        />
        <Choice
          icon={<ClipboardPaste size={18} />}
          title="Paste keys"
          text="Paste the keys from the access portal, or any credentials block. They're checked with AWS before they're saved."
          onClick={() => open({ kind: 'paste', projectId })}
        />
      </div>
    </Modal>
  );
}

function Choice({ icon, title, text, onClick, recommended = false }: { icon: ReactNode; title: string; text: string; onClick: () => void; recommended?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-primary hover:bg-surface-hover"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-text">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-semibold text-heading">
          {title}
          {recommended && <span className="rounded-full bg-success-bg px-1.5 py-px text-[0.625rem] font-semibold text-success">Recommended</span>}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{text}</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
    </button>
  );
}

export function ConfirmDialog({ title, body, confirmLabel, danger, option, onConfirm }: Extract<Dialog, { kind: 'confirm' }>) {
  const { close, toast } = useApp();
  const { busy, error, submit } = useSubmit();
  const [checked, setChecked] = useState(option?.defaultChecked ?? false);
  const confirm = async () => {
    const r = await submit(async () => {
      await onConfirm(checked);
      return true;
    });
    if (r) {
      close();
      toast('Done.');
    }
  };
  return (
    <Modal
      title={title}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy} onClick={() => void confirm()}>
            {busy && <Loader2 size={13} className="animate-spin" />} {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-text">{body as ReactNode}</div>
      {option && (
        <label className="mt-4 flex items-start gap-2 rounded-md border border-border bg-surface-alt px-3 py-2.5 text-sm">
          <input type="checkbox" className="mt-1" checked={checked} onChange={e => setChecked(e.target.checked)} />
          <span>{option.label}</span>
        </label>
      )}
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

/** Moves a profile to another project. Nothing in ~/.aws changes. */
export function MoveDialog({ profileId }: { profileId: string }) {
  const { state, close } = useApp();
  const profile = state.profiles.find(p => p.id === profileId);
  const [projectId, setProjectId] = useState(profile?.projectId ?? '');
  const { busy, error, submit } = useSubmit();
  if (!profile) return null;
  const move = async () => {
    if ((await submit(() => api.updateProfile({ id: profileId, projectId }))) !== undefined) close();
  };
  return (
    <Modal
      title={<>Move <span className="font-mono">{profile.name}</span></>}
      onClose={close}
      footer={<><button className="btn" onClick={close}>Cancel</button><button className="btn-primary" disabled={busy || projectId === profile.projectId} onClick={() => void move()}>Move</button></>}
    >
      <label className="field-label" htmlFor="move-project">To project</label>
      <ProjectSelect id="move-project" value={projectId} onChange={setProjectId} />
      <Hint>Only changes where it's listed here. The profile in ~/.aws stays exactly the same.</Hint>
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

/**
 * The folders a project's repos live in. Claude Code, working in one of them
 * (or a folder below), sees this project's profiles, and only those.
 */
export function FoldersDialog({ projectId }: { projectId: string }) {
  const { state, close, toast } = useApp();
  const project = state.projects.find(p => p.id === projectId);
  const [folders, setFolders] = useState<string[]>(project?.folders ?? []);
  const [draft, setDraft] = useState('');
  const { busy, error, submit } = useSubmit();
  if (!project) return null;
  const elsewhere = (folder: string) => state.projects.find(p => p.id !== projectId && p.folders.includes(folder))?.name;
  const add = () => {
    const folder = draft.trim().replace(/(.)\/+$/, '$1');
    if (folder && !folders.includes(folder)) setFolders([...folders, folder]);
    setDraft('');
  };
  const save = async () => {
    const pending = draft.trim() ? [...folders, draft.trim()] : folders;
    if ((await submit(() => api.setProjectFolders(projectId, pending))) !== undefined) {
      toast('Folders saved.');
      close();
    }
  };
  return (
    <Modal
      title={`Folders for ${project.name}`}
      onClose={close}
      footer={<><button className="btn" onClick={close}>Cancel</button><button className="btn-primary" disabled={busy} onClick={() => void save()}>Save</button></>}
    >
      <p className="mb-3 text-sm text-muted">
        Where {project.name}'s repos live. Claude Code working in one of these folders, or a folder inside them, sees {project.name}'s profiles, and only those.
      </p>
      {folders.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {folders.map(f => (
            <li key={f} className="flex items-center gap-2 rounded-md border border-border bg-surface-alt px-3 py-1.5">
              <Folder size={13} className="shrink-0 text-muted" />
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-text">{f}</code>
              {elsewhere(f) && <span className="text-[0.6875rem] text-warning">moves from {elsewhere(f)}</span>}
              <button className="btn-ghost p-1" title="Remove" onClick={() => setFolders(folders.filter(x => x !== f))}><X size={13} /></button>
            </li>
          ))}
        </ul>
      )}
      <label className="field-label" htmlFor="folder-new">Add a folder</label>
      <div className="flex gap-2">
        <input
          id="folder-new"
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          className="field font-mono text-xs"
          placeholder="~/repos/acme-*"
          spellCheck={false}
        />
        <button className="btn" disabled={!draft.trim()} onClick={add}><Plus size={13} /> Add</button>
      </div>
      <Hint>
        A full path. <code className="font-mono">*</code> matches part of a folder name: <code className="font-mono">~/repos/acme-*</code> covers ~/repos/acme-api and
        ~/repos/acme-web. Claude can also link a repo itself, after asking you which project it belongs to.
      </Hint>
      {!state.claude.sync && <Hint>Sync with Claude is off; turn it on in the top bar.</Hint>}
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}
