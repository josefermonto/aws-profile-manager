import { useEffect, useRef, useState } from 'react';
import { Monitor, Sun, Moon, ChevronDown, Check } from 'lucide-react';
import type { ThemePreference } from '../lib/useTheme';

interface Props {
  preference: ThemePreference;
  onChange: (p: ThemePreference) => void;
  /** 'nav' sits on the dark top bar; 'surface' sits on themed content (setup page). */
  variant?: 'nav' | 'surface';
}

const OPTIONS: { value: ThemePreference; icon: typeof Sun; label: string }[] = [
  { value: 'system', icon: Monitor, label: 'System' },
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
];

/** Theme dropdown: System / Light / Dark. */
export function ThemeToggle({ preference, onChange, variant = 'nav' }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const current = OPTIONS.find(o => o.value === preference) ?? OPTIONS[0];
  const CurrentIcon = current.icon;

  const triggerCls =
    variant === 'nav'
      ? 'bg-white/10 text-nav-text hover:bg-white/15'
      : 'bg-surface border border-border-strong text-text hover:bg-surface-alt';

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        onClick={() => setOpen(v => !v)}
        title="Color theme"
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${triggerCls}`}
      >
        <CurrentIcon size={13} />
        <span>{current.label}</span>
        <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full mt-1.5 z-50 w-36 rounded-lg ci-scale-in
                     bg-surface border border-border shadow-pop overflow-hidden p-1"
        >
          {OPTIONS.map(({ value, icon: Icon, label }) => {
            const active = preference === value;
            return (
              <button
                key={value}
                role="option"
                aria-selected={active}
                onClick={() => { onChange(value); setOpen(false); }}
                className={[
                  'w-full flex items-center gap-2 px-2.5 py-2 text-xs rounded-md transition-colors',
                  active
                    ? 'bg-surface-hover text-primary font-semibold'
                    : 'text-text hover:bg-surface-alt',
                ].join(' ')}
              >
                <Icon size={14} />
                <span className="flex-1 text-left">{label}</span>
                {active && <Check size={13} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
