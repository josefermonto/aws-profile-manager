/** Mirrors the service's getState snapshot (server/domain/state.js). No secret values ever appear here. */

export type StatusState = 'active' | 'expiring' | 'expired' | 'signed-out' | 'long-lived' | 'unknown' | 'error';

export interface Status {
  state: StatusState;
  /** When it ends, if known. */
  expiresAt: string | null;
  /** The countdown is the app's own estimate, not a time AWS reported. */
  estimated: boolean;
  since?: string;
  note?: string;
  signedInAt?: string;
}

export interface Project {
  id: string;
  name: string;
  /** Where its repos live (`~/repos/acme-*`): Claude sees this project's profiles there. */
  folders: string[];
}

export type LabelColor = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink';

/** What's known about an AWS account; its label and color are shared by all its profiles. */
export interface Account {
  name: string | null;
  label: string;
  color: LabelColor | null;
}

export interface Portal {
  id: string;
  name: string;
  startUrl: string;
  region: string;
  sessionName: string;
  projectId: string | null;
  /** How long a sign-in lasts, learned when a previous one ended; null until then. */
  sessionMs: number | null;
  status: Status;
  profileCount: number;
}

export interface KeysCheck {
  at: string;
  ok: boolean;
  code: 'expired' | 'invalid' | 'unreachable' | null;
  message: string | null;
}

export interface Profile {
  id: string;
  name: string;
  projectId: string;
  /** The role: the SSO role name, or the principal STS reported for pasted keys. */
  label: string;
  kind: 'sso' | 'keys';
  accountId: string | null;
  region: string;
  output: string;
  sso?: { portalId: string; roleName: string; exportKeys: boolean; keysExpireAt: string | null; keysError: string | null };
  keys?: {
    temporary: boolean;
    pastedAt: string | null;
    expiresAt: string | null;
    /** How long they last, and where that came from: the role's session length, a previous paste, or the AWS default. */
    lifetimeMs: number | null;
    expiryBasis: 'role' | 'learned' | 'default' | null;
    check: KeysCheck | null;
  };
  status: Status;
  conflicts: { file: 'config' | 'credentials'; section: string }[];
  missing: boolean;
}

export interface UnmanagedProfile {
  name: string;
  kind: 'sso' | 'sso-legacy' | 'assume-role' | 'process' | 'keys' | 'other';
  temporary: boolean;
  keyId: string | null;
  region: string | null;
  ssoSession: string | null;
  accountId: string | null;
  roleName: string | null;
  inConfig: boolean;
  inCredentials: boolean;
  warnings: string[];
}

export interface AppState {
  now: string;
  settings: { warnMinutes: number; notifications: boolean; claudeSync: boolean };
  projects: Project[];
  accounts: Record<string, Account>;
  portals: Portal[];
  profiles: Profile[];
  unmanaged: UnmanagedProfile[];
  summary: { active: number; expiring: number; expired: number; attention: number };
  paths: { config: string; credentials: string; appHome: string; backups: string };
  shell: { scriptPath: string; zshrc: string; installed: boolean; sourceLine: string };
  claude: { sync: boolean; skill: boolean; hook: boolean; skillFile: string; settingsFile: string; cli: string };
  port: number;
}

export interface SsoAccount {
  accountId: string;
  accountName: string;
  email: string | null;
  roles: { roleName: string; profiles: string[] }[];
}

export interface SignInStart {
  flowId: string;
  userCode: string | null;
  verificationUri: string | null;
  expiresIn: number;
  interval: number;
}
