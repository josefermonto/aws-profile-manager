import type { Status, StatusState } from '../types';

/** "3h 12m", "9m", "45s". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The state to show right now. The service recomputes every 30 s; between
 * snapshots the countdown keeps going here, so a chip turns amber or red on time.
 */
export function liveState(status: Status, nowMs: number, warnMinutes: number): StatusState {
  if (!status.expiresAt || (status.state !== 'active' && status.state !== 'expiring')) return status.state;
  const left = Date.parse(status.expiresAt) - nowMs;
  if (left <= 0) return 'expired';
  return left <= warnMinutes * 60_000 ? 'expiring' : 'active';
}

export const STATE_LABEL: Record<StatusState, string> = {
  active: 'Active',
  expiring: 'Expiring',
  expired: 'Expired',
  'signed-out': 'Signed out',
  'long-lived': 'No expiry',
  unknown: 'Not checked yet',
  error: 'Problem',
};

/** "~3h 12m left", "expired 20m ago", or null when there's no time to show. */
export function timeText(status: Status, state: StatusState, nowMs: number): string | null {
  if ((state === 'active' || state === 'expiring') && status.expiresAt) {
    return `${status.estimated ? '~' : ''}${duration(Date.parse(status.expiresAt) - nowMs)} left`;
  }
  if (state === 'expired') {
    const since = status.since ?? status.expiresAt;
    return since ? `${duration(nowMs - Date.parse(since))} ago` : null;
  }
  return null;
}
