# AWS Profile Manager: design

Date: 2026-11-05 · Status: architecture approved; data model, status model and screens are defaults chosen during implementation (review welcome).

## Goal

One local UI to manage AWS profiles across client projects, so nobody edits `~/.aws/config` and `~/.aws/credentials` by hand:

- Projects → AWS accounts (labeled Prod, Dev…) → profiles (e.g. Admin, PowerUser), all in one table.
- Paste credentials, or sign in with IAM Identity Center (SSO) and pick accounts and roles.
- See every profile's status (active, expiring, expired, signed out) with time left, and get a macOS alert to sign in again or paste new keys before things expire.
- Switch profiles per terminal with `awspm use <profile>`.

## Decisions (from the brainstorm)

| # | Question | Decision |
|---|---|---|
| 1 | How SSO profiles land in `~/.aws` | **Native SSO profiles** (`[sso-session]` + `[profile]` with `sso_account_id`/`sso_role_name`), plus a per-profile **"also write plain keys"** option for tools that only read `~/.aws/credentials`. |
| 2 | How it runs | **launchd agent** that starts at login: one Node process serving UI + API on `127.0.0.1:5005`, watching expiry, sending notifications. `npm start` for development. |
| 3 | What "switch" means | **Per terminal.** `awspm use <profile>` (zsh function with completion) sets `AWS_PROFILE` in that shell; the UI copies `export AWS_PROFILE=…`. A colored prompt tag (e.g. `[ACME PROD]`) shows the active profile. `[default]` is never touched. |
| 4 | Ownership of `~/.aws` | **Adopted profiles only.** The app rewrites only the sections it manages; everything else is preserved byte for byte. First-run import lets you adopt existing profiles one by one. (Full ownership may come later.) |
| 5 | SSO sign-in mechanism | **The app runs the device-code sign-in itself** and writes the token to `~/.aws/sso/cache` in the format the CLI and SDKs read. Works when the link is approved in another browser or an AWS WorkSpace. |

## Architecture

```
Browser tab ─┐                                   ┌─ ~/.aws/config, ~/.aws/credentials
macOS notif ─┼─ AWS Profile Manager service ────┼─ ~/.aws/sso/cache/<sha1(session)>.json
awspm (zsh) ─┘  Node 22, launchd, 127.0.0.1:5005 ├─ ~/.aws-profile-manager/{store.json, backups/, awspm.zsh, profiles.tsv}
                                                  └─ AWS: IAM Identity Center (OIDC, portal), STS
```

AWS tools (CLI, CDK, boto3, JS SDK) read `~/.aws` directly and never talk to the service. If it's stopped, SSO profiles keep working until the sign-in ends; only alerts and plain-key renewal pause.

Repo layout: npm workspaces `server/` (CommonJS, Jest) and `frontend/` (React 18, Vite, Tailwind, lucide-react), with Cloudscape-style tokens and a light/dark theme. The API is one endpoint, `POST /api` with `{ operation, payload }`.

### Server modules

| Module | Responsibility |
|---|---|
| `core/paths.js` | Locations. Honors `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `PROFILE_MANAGER_HOME` (tests use temp dirs). |
| `core/ini.js` | Section-preserving INI model: parse to ordered sections of raw lines, read key/values, replace/append/remove one section, serialize unchanged sections verbatim. |
| `core/awsFiles.js` | Lists every profile in both files; applies section edits with backup → temp file → rename, mode `600`; per-section fingerprints for outside-edit detection. |
| `core/store.js` | `~/.aws-profile-manager/store.json` (mode `600`): projects, account labels, portals, profile metadata, settings. **No secrets.** |
| `sso/ssoService.js` | Device sign-in, account/role listing, role credentials, region discovery, plus refresh-token support. |
| `sso/tokenCache.js` | Read/write `~/.aws/sso/cache/<sha1(sessionName)>.json` (`startUrl, region, accessToken, expiresAt, clientId, clientSecret, registrationExpiresAt, refreshToken`). |
| `creds/parseCreds.js` | Parses a pasted credentials block. Reads `[123456789012_RoleName]` headers from the portal's block. |
| `creds/sts.js` | `GetCallerIdentity` check for pasted keys. |
| `status/status.js` | Pure: profile + portal + token cache + now → status. |
| `status/watcher.js` | Every 30 s: refresh SSO tokens, renew plain keys, probe pasted keys, fire notifications, write `profiles.tsv`. |
| `status/notifier.js` | macOS alerts: an `osascript` dialog with the fix (*Sign in again* / *Paste new keys*) and *Ignore*; the action opens the app at that dialog (`#sign-in=<portal>`, `#paste=<profile>`). |
| `shell/shellHelper.js` | Generates `awspm.zsh`; adds one `source` line to `~/.zshrc` only when asked. |
| `claude/claude.js` | Sync with Claude: installs/removes the skill, the launcher and its `~/.claude/settings.json` entries; answers `context`, `link` and `hook`. |
| `claude/policy.js` | Pure: a shell command + profile facts → deny / ask / no opinion. |
| `claude/cli.js` | `awspm-claude context | link | hook`, run by Claude Code; asks the service over HTTP. |
| `service.js` | `install` / `uninstall` / `status` for the launchd agent `local.aws-profile-manager`. |
| `http/app.js` | Loopback-only server: checks remote address, `Host`, `Origin`, JSON body; serves `frontend/dist` with a strict CSP. |

## Data model (`store.json`)

```js
{
  version: 2,
  settings: { warnMinutes: 15, notifications: true },
  learnedKeyLifetimes: { '<accountId>:<role>': ms },
  projects: [{ id, name }],
  accounts: { '<accountId>': { name, label, color } },      // label + color shared by every profile in the account
  portals:  [{ id, name, projectId?, startUrl, region, sessionName, sessionMs /* detected; null until a sign-in has ended */,
               session?: { clientId, signedInAt, endsAt? } }],
  profiles: [{
    id, name, projectId, label /* the role */, accountId?, region, output: 'json',
    kind: 'sso' | 'keys',
    sso?:  { portalId, roleName, exportKeys: false, keysExpireAt? },
    keys?: { temporary, pastedAt?, expiresAt?, lifetimeMs?, expiryBasis?, lifetimeKey?, check?: { at, ok, code? } },
    fingerprints: { config?, credentials? }   // sha256 of each section as last written
  }]
}
```

- **No environments.** In AWS an account usually *is* the environment, so the label (Prod, Dev, Sandbox…) and color live on the account and every profile in it shares them. Version 1 stores (projects → environments → profiles) were migrated once: each environment's name and color became its accounts' label and color.
- A profile's AWS name defaults to `<project>-<label>-<role>` (e.g. `acme-prod-admin`) and is fixed after creation (scripts depend on it). Adopted profiles keep their existing names.
- **"Also write plain keys"** writes a sibling profile `<name>-keys` to `~/.aws/credentials` (plus `[profile <name>-keys]` with the region in config), renewed by the watcher. A sibling avoids the precedence trap: the JS SDK prefers static keys over SSO in the same profile, so expired keys would shadow a valid SSO sign-in.
- Label colors are 8 vivid hues (red, orange, yellow, green, teal, blue, purple, pink) or none. Labels are guessed from account names (camelCase too: `AcmeAWSOwnerDataPlatformProd` → Prod), colors from labels (Prod red, Staging/UAT orange, QA/Test blue, Dev green, Sandbox yellow, others spread over the palette). Labels show as solid badges and statuses as soft pills with a dot, so a red Prod label doesn't read as "expired".
- A portal can belong to a project. Its name defaults to "<Project> SSO" (editable); the `[sso-session]` name is its slug, never one already in the config.

### Files the app writes

```ini
# ~/.aws/config
[sso-session acme]
sso_start_url = https://acme.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile acme-prod-admin]
sso_session = acme
sso_account_id = 123456789012
sso_role_name = AdministratorAccess
region = us-east-1
output = json

[profile acme-dev-poweruser]   # pasted keys: region/output here, keys in credentials
region = us-east-1
output = json
```

Adopting an existing profile rewrites a bare `[name]` section in `config` as `[profile name]`. The CLI ignores bare sections other than `[default]`, which is why the region set there today isn't applied.

## Status model

| State | Color | Meaning |
|---|---|---|
| `active` | green | Valid; time left shown when known. |
| `expiring` | amber | Less than `warnMinutes` (default 15) left. |
| `expired` | red | Sign-in ended, or STS reported the keys expired. |
| `signed-out` | grey | SSO profile with no token in the cache. |
| `long-lived` | blue-grey | IAM user keys with no session token (no expiry). |
| `unknown` | grey | Pasted temporary keys not yet checked. |
| `error` | red outline | Check failed for another reason (invalid keys, renewal failed). |

**SSO profiles** take their portal's status. AWS never reports how long a sign-in lasts: the Identity Center session length (default 8 h, 15 min to 90 days) is an admin setting no API returns, and CreateToken has no refresh-token expiry. So:

- A cached access token past its expiry is **expired**, whatever else is known: the watcher renews tokens 20 min early, so an expired one couldn't be renewed and the CLI fails too. Until AWS has refused a renewal it's marked estimated (it may be offline) and renewal is retried every minute.
- The watcher renews the access token 20 min before it expires. Near the sign-in's end AWS still renews but caps the new token at that end, so a renewal that doesn't push the expiry out has found the **exact** end (`session.endsAt`), about 20 min ahead: the portal goes to *expiring* with a real countdown, renewing stops, then *expired*. A refused renewal (any 4xx other than throttling; after the end it's `InvalidRequestException`) ends it at the last token's expiry. No answer or a 5xx is a blip, retried.
- Until the end is known, time left is estimated (`~`) from the sign-in time plus Identity Center's default 8-hour session, and the UI says it's the default.
- The real session length is **detected** from the exact end (`endsAt − signedInAt`, rounded up to whole hours, or quarter hours below one) and stored on the portal; later sign-ins count down from it. If a sign-in outlives the expected length by an hour while AWS keeps renewing it, the length is raised.
- Sign-ins done outside the app (`aws sso login`) are picked up from the cache; their start time is taken from the cache file's modification time.

**Pasted temporary keys:** the session token doesn't reveal its expiry and STS doesn't report it, so the lifetime is worked out from the session that issued them (`creds/expiry.js`), counted from the paste:

1. IAM Identity Center keys (`assumed-role/AWSReservedSSO_…`): the role's `MaxSessionDuration` via `iam:GetRole` with the pasted keys, which equals the permission set's session duration, i.e. what the portal issues.
2. Otherwise the lifetime learned for that account + role (`store.learnedKeyLifetimes`), else the AWS default: 1 h for AssumeRole sessions, 12 h for GetSessionToken / GetFederationToken.
3. The watcher calls STS `GetCallerIdentity` every 5 min, every minute in the last 10 minutes, and right after the estimate passes (long-lived keys: hourly). The first "expired" answer records the observed lifetime (rounded to the quarter hour) for the next paste. A fresh STS result always overrides the estimate.

There is no manual "expires in" field. Adopted keys have no paste time, so they get no countdown; STS still flips them to Expired.

**Alerts:** a macOS dialog, shown by the service, with the fix one click away and *Ignore*. SSO alerts are per portal and only for what AWS confirmed: when the exact end is found ("Your AWS sign-in ends at 5:41 PM, in 20 min. 3 profiles stop working then.") and when it has ended; an estimated countdown raises none. Key alerts go out when keys enter the warning window and when they expire. *Ignore* silences that subject (one sign-in, one batch of keys) until it changes; a newer alert about the same subject replaces one still on screen. Nothing is announced for what had already expired when the service started. The browser tab title also shows problems (`⚠ 2 need attention · AWS Profile Manager`).

## Screens

One page, no navigation:

- **Top bar:** brand, status pills (active / expiring / expired / problems), **Settings** (dialog: alerts, terminal helper, file locations), theme toggle.
- **Getting started:** the three steps (create a project, add an SSO portal, adopt existing profiles), always shown, each ticked once done.
- **Toolbar:** search (profile, account number/name/label, role, project, region), **New project**, **Add SSO portal**, **Paste keys**.
- **The table**, grouped by project. A group header shows the project, its counts, its SSO sign-in(s) with time left and Sign in / Sign in again, **Add SSO accounts**, **Paste keys**, and a menu (rename, add another portal, delete). Rows: account (label badge, click to edit label + color for the whole account; name; number), role (and source), profile name, region (click to change), status with countdown, and **Use** (copies `export AWS_PROFILE=…`) + a menu (check keys, also write plain keys, move to another project, stop managing, delete).
- **Unmanaged in ~/.aws:** a collapsed group at the bottom with every profile the app doesn't manage, warnings (e.g. bare config section), **Adopt** per row and **Adopt all**.
- **Add SSO accounts:** after signing in, every account is pre-ticked with every role it offers; label and color per account (guessed, editable); role toggles at the top apply to every account; the profile names to be created are shown; one region and "also write plain keys" for the batch.
- **New project** is followed by "How do you want to add its profiles?" (Sign in with SSO / Paste keys / Later).
- **Deleting** a project deletes its profiles and (when removing from files) its own portals that nothing else uses. The confirmation lists the profiles and offers "Also remove them from ~/.aws" (default on, backed up first); off, they stay in the files as unmanaged.

## Claude Code

The toggle in the top bar (`settings.claudeSync`). Claude never gets a copy of the profile list: it asks the service, so additions, removals and expiries reach it at once.

- **On** writes `~/.aws-profile-manager/bin/awspm-claude` (a launcher for `server/claude/cli.js` with the service's Node path), the skill `~/.claude/skills/aws-profiles/SKILL.md`, and in `~/.claude/settings.json` a `PreToolUse` hook (`matcher: Bash`, `awspm-claude hook`, 10 s timeout) plus the allow rule `Bash(<launcher> context *)`. `settings.json` is backed up first and only these entries change; an invalid file, or an `aws-profiles` skill the app didn't write, is left alone with an error. **Off** removes exactly them. On every start the launcher and skill are rewritten (Node or repo may have moved); `settings.json` is not.
- **Folders:** `project.folders` (`~/…` or absolute; `*` within one folder name; the most specific match wins; a folder belongs to one project). `context` lists only the matching project's profiles; in an unlinked folder it lists project names and tells Claude to ask, then `awspm-claude link "<project>"` links the repo root.
- **Hook verdicts** (`policy.js`), per simple command in a chain: *deny* reading `~/.aws/credentials` or `~/.aws/sso/cache`; credentials printed to the screen (`sts get-session-token`/`assume-role*`/`get-federation-token`, `sso get-role-credentials`, `ecr get-login-password`, `configure export-credentials`, `configure get` of a secret; fine when piped); `aws configure set/import/sso`; an AWS call with no `--profile`/`AWS_PROFILE` (local commands like `cdk synth`, `sam build`, `--version` excepted); a managed profile that's expired, signed out or rejected (with the fix link). *Ask* for a change (anything but describe/list/get-style reads; `s3 cp` to S3; `cdk deploy`; `terraform apply`…) in an account whose label is Prod, and for a profile of another project than the folder's. Otherwise no opinion: Claude's normal permissions apply. With the service down, only the stateless checks run; a failing hook never blocks Claude.

## Security

- Binds `127.0.0.1` only. Requests must come from loopback with `Host` and `Origin` (when sent) equal to `localhost:5005`/`127.0.0.1:5005`, which blocks other devices, other sites, and DNS rebinding. API is `POST` + `application/json` only.
- **Secrets never go to the browser.** The UI only receives metadata and statuses. Pasted keys travel UI → server once and go straight to `~/.aws/credentials`. SSO tokens stay on the server side in the CLI cache.
- No second copy of any secret: `store.json` holds metadata and section hashes only.
- Files and backups `600`, app directories `700`. The newest 20 backups per file are kept in `~/.aws-profile-manager/backups/`.
- Request bodies, keys and tokens are never logged.
- UI served with a strict CSP (`default-src 'self'`), and no external fonts or CDNs.

## Error handling

- **Outside edits:** each managed section's fingerprint is compared before writing. If it changed, the profile shows "changed outside AWS Profile Manager" and the write is refused until you choose **Use file version** (re-read metadata, accept) or **Overwrite**.
- **Sign-in:** code expired / denied / slow-down handled; refresh failure marks the portal expired and notifies.
- **STS check:** `ExpiredToken*` → expired; `InvalidClientTokenId`/`SignatureDoesNotMatch` → error ("keys invalid"); network errors keep the previous status and retry next tick.
- **Port in use:** the service exits with "already running? `npm run service:status`".

## Testing

Jest on the server: INI round-trips (comments, order, bare sections, nested keys), section edits, adopt (prefix fix), backups and modes, fingerprint conflicts, credentials parsing (portal header), status computation (every state and boundary), token cache file name/format, SSO service (mocked clients, refresh), request guards (host/origin/loopback/JSON), `awspm.zsh` rendering. Frontend: `tsc --noEmit` and `vite build`.

## Out of scope (v1)

Assume-role chains (`role_arn`/`source_profile`), MFA, credential_process/Keychain storage for long-lived keys, console sign-in links, menu-bar app, renaming profiles, multiple sign-ins per portal.
