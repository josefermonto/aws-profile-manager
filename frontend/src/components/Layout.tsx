import { Settings } from 'lucide-react';
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
        <button
          onClick={() => open({ kind: 'settings' })}
          title="Settings"
          className="ml-2 flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-nav-text transition-colors hover:bg-white/15"
        >
          <Settings size={13} /> Settings
        </button>
        <ThemeToggle preference={preference} onChange={setTheme} />
      </div>
    </header>
  );
}
