import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { AWS_REGIONS, regionName } from '../lib/awsRegions';

interface Props {
  id?: string;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Smaller field, for compact forms. */
  compact?: boolean;
}

/**
 * A region field: type a code, or pick from the list of AWS regions (search
 * by code or name). The region's name shows under the field once it's known.
 */
export function RegionInput({ id, value, onChange, disabled, placeholder = 'us-east-1', className = '', compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  // While the list is open, typing filters it; a fresh open shows everything.
  const options = useMemo(() => {
    const q = (query ?? '').trim().toLowerCase();
    return q ? AWS_REGIONS.filter(r => r.code.includes(q) || r.name.toLowerCase().includes(q)) : AWS_REGIONS;
  }, [query]);

  const choose = (code: string) => {
    onChange(code);
    setOpen(false);
    setQuery(null);
  };

  const name = regionName(value);

  return (
    <div className={`relative ${className}`}>
      <div className="relative">
        <input
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          onChange={e => {
            onChange(e.target.value);
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setHighlight(h => Math.min(h + 1, options.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight(h => Math.max(h - 1, 0));
            } else if (e.key === 'Enter' && open && options[highlight]) {
              e.preventDefault();
              choose(options[highlight].code);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          className={[
            'w-full rounded-md border border-border-strong bg-surface pr-8 font-mono text-text placeholder-muted',
            'focus:outline-none focus:ring-1 focus:ring-focus focus:border-focus transition-shadow disabled:opacity-60',
            compact ? 'py-1.5 pl-2.5 text-xs' : 'h-10 pl-3 text-sm',
          ].join(' ')}
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onMouseDown={e => {
            e.preventDefault();
            setQuery(null);
            setOpen(o => !o);
          }}
          aria-label="Show regions"
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted hover:text-text"
        >
          <ChevronDown size={14} />
        </button>
        {open && !disabled && options.length > 0 && (
        <ul
          role="listbox"
          // Compact forms sit in scrolling popovers that would clip a floating list, so it goes inline there.
          className={[
            'mt-1 w-full overflow-y-auto rounded-md border border-border bg-surface py-1',
            compact ? 'relative max-h-48' : 'absolute left-0 top-full z-50 max-h-64 min-w-[260px] shadow-pop',
          ].join(' ')}
        >
          {options.map((r, i) => (
            <li
              key={r.code}
              role="option"
              aria-selected={r.code === value}
              // onMouseDown, not onClick: it fires before the input's blur closes the list.
              onMouseDown={e => {
                e.preventDefault();
                choose(r.code);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={[
                'flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-xs',
                i === highlight ? 'bg-surface-hover' : '',
                r.code === value ? 'font-semibold text-primary' : 'text-text',
              ].join(' ')}
            >
              <span className="w-28 shrink-0 font-mono">{r.code}</span>
              <span className="truncate text-muted">{r.name}</span>
            </li>
          ))}
        </ul>
        )}
      </div>
      <p className="mt-1 min-h-[16px] truncate text-[0.6875rem] text-muted">{name ?? (value.trim() ? 'Custom region code' : '')}</p>
    </div>
  );
}
