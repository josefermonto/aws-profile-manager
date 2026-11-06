import { Bot, Settings } from 'lucide-react';
import { api } from '../api';
import { ThemeToggle } from './ThemeToggle';
import { AwsLogo } from './AwsLogo';
import { useTheme } from '../lib/useTheme';
import { useApp } from '../lib/appContext';
import { liveState } from '../lib/format';

/** Live counts for the top bar, using the same countdown as the chips. */
function useLiveSummary() {
  const { state, now } = useApp();
  const counts = { active: 0, expiring: 0, expired: 0, problem: 0 };
  for (const p of state.profiles) {
    const s = liveState(p.status, now, state.settings.warnMinutes);
    if (s === 'active' || s === 'long-lived') counts.active += 1;
    else if (s === 'expiring') counts.expiring += 1;
    else if (s === 'expired') counts.expired += 1;
    else if (s === 'error') counts.problem += 1;
  }
  return counts;
}

export function TopBar() {
  const { preference, setTheme } = useTheme();
  const { open } = useApp();
  const counts = useLiveSummary();
  const pill = (n: number, label: string, cls: string) => (
    <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold ${cls}`}>
      <span className="text-sm leading-none">{n}</span> {label}
    </span>
  );
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-nav-border bg-nav px-4 text-nav-text">
      <span className="flex items-center gap-2 font-semibold">
        <AwsLogo size={26} tile />
        <span className="text-sm">AWS Profile Manager</span>
      </span>
      <div className="ml-auto flex items-center gap-2">
        {pill(counts.active, 'active', 'bg-white/10 text-nav-text')}
        {counts.expiring > 0 && pill(counts.expiring, 'expiring', 'bg-[#e3b341] text-[#241f10]')}
        {counts.expired > 0 && pill(counts.expired, 'expired', 'bg-[#ff7b72] text-[#2a1615]')}
        {counts.problem > 0 && pill(counts.problem, counts.problem === 1 ? 'problem' : 'problems', 'border border-[#ff7b72] text-[#ff9b93]')}
        <ClaudeToggle />
        <button
          onClick={() => open({ kind: 'settings' })}
          title="Settings"
          className="flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-nav-text transition-colors hover:bg-white/15"
        >
          <Settings size={13} /> Settings
        </button>
        <ThemeToggle preference={preference} onChange={setTheme} />
      </div>
    </header>
  );
}

/**
 * "Sync with Claude": installs a skill and a command check for Claude Code, so
 * it asks this app for the right profile, live. Turning it on asks first,
 * since it writes to ~/.claude; turning it off removes exactly that.
 */
function ClaudeToggle() {
  const { state, open, run } = useApp();
  const { sync, skill, hook } = state.claude;
  const broken = sync && (!skill || !hook);
  const turnOn = () =>
    open({
      kind: 'confirm',
      title: 'Sync with Claude Code?',
      body: (
        <div className="space-y-2">
          <p>Claude Code then asks this app which profile to use, for the repo it's working in, with live sign-in status. It never sees keys or tokens.</p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
            <li>
              Adds the skill <code className="font-mono">~/.claude/skills/aws-profiles</code>: before AWS work, Claude lists the profiles of the project the repo is linked to.
            </li>
            <li>
              Adds a check before every terminal command Claude runs. It stops commands that would show credentials, use no profile, or use an expired sign-in (with the
              link to fix it), and asks you before changes in a Prod-labeled account or with another project's profile.
            </li>
            <li>
              In <code className="font-mono">~/.claude/settings.json</code>: that check, and permission to list profiles without asking. The file is backed up first; nothing else in it changes.
            </li>
          </ul>
          <p className="text-xs text-muted">Link each project to its repo folders (project menu, Folders for Claude), or Claude will ask you. Turning sync off removes all of it.</p>
        </div>
      ),
      confirmLabel: 'Turn on',
      onConfirm: () => api.setClaudeSync(true),
    });
  const turnOff = () => void run(() => api.setClaudeSync(false), 'Claude sync is off: its skill and command check were removed.');
  const title = broken
    ? `Part of the Claude setup is missing (${[!skill && 'the skill', !hook && 'the command check'].filter(Boolean).join(' and ')}). Turn sync off and on to restore it.`
    : sync
      ? 'Claude Code asks this app for profiles, live. Click to turn off.'
      : 'Let Claude Code ask this app which AWS profile to use. Click to set up.';
  return (
    <button
      onClick={sync ? turnOff : turnOn}
      title={title}
      role="switch"
      aria-checked={sync}
      className="ml-2 flex items-center gap-2 rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-nav-text transition-colors hover:bg-white/15"
    >
      <Bot size={13} />
      Sync with Claude
      <span className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors ${sync ? (broken ? 'bg-[#e3b341]' : 'bg-[#3fb950]') : 'bg-white/25'}`}>
        <span className={`absolute h-2.5 w-2.5 rounded-full bg-white shadow transition-transform ${sync ? 'translate-x-3' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );
}
