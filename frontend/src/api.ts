import type { AppState, LabelColor, SignInStart, SsoAccount } from './types';

/** A failed API call; `conflicts` is set when a managed section changed outside the app (HTTP 409). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly conflicts?: { file: string; section: string }[]) {
    super(message);
  }
}

/** POST /api { operation, payload }, the same API shape as connect-inspector. */
export async function call<T = unknown>(operation: string, payload: unknown = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, payload }),
    });
  } catch {
    throw new ApiError("Can't reach the AWS Profile Manager service. Is it running? (npm run service:status)", 0);
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON: the service is down behind a proxy, or crashed mid-request
  }
  if (!res.ok) {
    throw new ApiError(data?.error ?? `Request failed (HTTP ${res.status}). Is the AWS Profile Manager service running?`, res.status, data?.conflicts);
  }
  return data as T;
}

export const api = {
  getState: () => call<AppState>('getState'),
  createProject: (name: string) => call<{ id: string }>('createProject', { name }),
  updateProject: (id: string, name: string) => call('updateProject', { id, name }),
  deleteProject: (id: string, deleteFromFiles: boolean) => call<{ profiles: number; portals: number }>('deleteProject', { id, deleteFromFiles }),
  updateAccount: (p: { accountId: string; label?: string; color?: LabelColor | null }) => call('updateAccount', p),
  updateSettings: (p: { warnMinutes?: number; notifications?: boolean }) => call('updateSettings', p),

  adoptProfiles: (items: { name: string; projectId: string }[]) => call<{ ids: string[] }>('adoptProfiles', { items }),
  pasteCredentials: (p: { profileId?: string; projectId?: string; name?: string; region?: string; accountLabel?: string; accountColor?: LabelColor | null; blob: string }) =>
    call<{
      id: string; warnings: string[]; accountId: string | null; principal: string | null;
      expiresAt: string | null; lifetimeMs: number | null; expiryBasis: 'role' | 'learned' | 'default' | null;
    }>('pasteCredentials', p),
  createSsoProfiles: (p: {
    portalId: string; projectId: string; region: string; exportKeys: boolean;
    accounts: { accountId: string; accountName: string; label: string; color: LabelColor | null; roles: { roleName: string; name: string }[] }[];
  }) => call<{ ids: string[] }>('createSsoProfiles', p),
  updateProfile: (p: { id: string; projectId?: string; region?: string; exportKeys?: boolean }) => call('updateProfile', p),
  removeProfile: (id: string, deleteFromFiles: boolean) => call('removeProfile', { id, deleteFromFiles }),
  resolveConflict: (id: string, action: 'accept' | 'restore') => call('resolveConflict', { id, action }),
  checkProfile: (id: string) => call('checkProfile', { id }),

  discoverRegion: (startUrl: string) => call<{ region: string | null }>('discoverRegion', { startUrl }),
  savePortal: (p: { id?: string; name: string; projectId: string | null; startUrl: string; region: string }) => call<{ id: string }>('savePortal', p),
  deletePortal: (id: string) => call('deletePortal', { id }),
  startSignIn: (portalId: string) => call<SignInStart>('startSignIn', { portalId }),
  pollSignIn: (flowId: string) => call<{ status: 'pending' | 'done' | 'expired' | 'denied'; slowDown?: boolean }>('pollSignIn', { flowId }),
  signOut: (portalId: string) => call('signOut', { portalId }),
  listAccounts: (portalId: string) => call<{ accounts: SsoAccount[] }>('listAccounts', { portalId }),

  installShell: () => call('installShell'),
  testNotification: () => call<{ shown: boolean; unsupported: boolean }>('testNotification'),
};

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
