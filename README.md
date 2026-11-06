# AWS Profile Manager

One local UI for your AWS profiles across client projects, instead of hand-editing `~/.aws/config` and `~/.aws/credentials`:

- **One table.** Every profile on one page, grouped by project (a client): account, role, profile name, region and status, edited in place. Each AWS account has a label (Prod, Dev…) and a color.
- **SSO sign-in.** Paste the access portal URL (the SSO region fills itself in), get a sign-in link and code, and approve it in any browser: this one, another one, or an AWS WorkSpace. All its accounts and roles are offered at once; each becomes a native SSO profile the AWS CLI, CDK, boto3 and the SDKs use directly.
- **Pasted credentials.** Paste the portal's credentials block (or its environment-variable form). The keys are checked with AWS STS, then written to `~/.aws/credentials`.
- **Status and expiry.** Every profile shows Active / Expiring / Expired / Signed out with time left, and a macOS alert with **Sign in again** (or **Paste new keys**) and **Ignore** pops up before a sign-in or keys expire, even with no browser tab open.
- **Per-terminal switching.** `awspm use acme-prod-admin` sets `AWS_PROFILE` in that terminal only, with tab completion and a colored `[ACME PROD ADMIN]` prompt tag.

Design notes: [docs/superpowers/specs/2026-11-05-aws-profile-manager-design.md](docs/superpowers/specs/2026-11-05-aws-profile-manager-design.md).

## Install

You need **Node.js 22+** and macOS.

```bash
npm install
npm run service:install
```

That builds the UI and registers a launchd agent (`local.aws-profile-manager`) that starts at login and restarts if it crashes. Open **http://localhost:5005**.

| Command | What it does |
|---|---|
| `npm run service:install` | Build the UI and (re)install the background service |
| `npm run service:status` | Is it loaded, and answering on :5005? |
| `npm run service:restart` | Restart it (e.g. after `git pull` + `npm run build`) |
| `npm run service:uninstall` | Remove the service. Your `~/.aws` files and `~/.aws-profile-manager` stay. |
| `npm start` | Development: API on :5005 with reload, UI with hot reload on :5006. Uninstall or stop the service first, as they share the port. |
| `npm test` | Server tests |
| `npm run typecheck` | Type-check the frontend |

If Node comes from nvm, the service runs that exact Node binary: run `npm run service:install` again after switching Node versions. Logs: `~/.aws-profile-manager/logs/service.log`.

## Using it

Everything is on one page: one table of every profile, grouped by project. Each project's header shows its SSO sign-in (with time left) and its **Add SSO accounts** / **Paste keys** buttons. Above it there's a search box and the three getting-started steps.

- **Accounts carry the label.** Each AWS account has a label (Prod, Dev, Sandbox…) and a color, shared by all its profiles (Admin, ReadOnly…). Click the label in the table to change it. Click a region to change it. A row's menu has the rest: check keys, also write plain keys, move to another project, stop managing, delete.
- **Add an SSO portal** (toolbar, or a project's header). Paste the URL; the SSO region fills itself in and the name defaults to "<Project> SSO". It's saved as `[sso-session <name>]` in `~/.aws/config`. Sign in: open or copy the link, check the code, approve. The sign-in is written to `~/.aws/sso/cache` in the AWS CLI's own format, so `aws`, CDK and the SDKs use it, and renew it, without `aws sso login`. (`aws sso login` in a terminal also works; the app picks it up.)
- **Add SSO accounts.** After signing in, every account the portal offers is pre-ticked with every role, a label guessed from the account name (`acme-prod` → Prod) and a color from the label. Edit any of them, untick what you don't want, or toggle a role off for every account at once. Profile names are `<project>-<label>-<role>` (e.g. `acme-prod-admin`). **Also write plain keys** additionally writes `<name>-keys` to `~/.aws/credentials` for tools that can't read SSO profiles, renewed while you're signed in.
- **Paste keys**: any form the portal offers, plus the account's label and color. When they expire is worked out for you. Keys from an SSO portal get the role's session length (read with `iam:GetRole`, the permission set's duration). Otherwise the app uses how long that role's keys lasted before, or the AWS default (1 h for role sessions, 12 h for user sessions). It checks them with STS every 5 minutes, every minute near the end, and learns the real length when they expire. Long-lived keys are checked hourly. Reading the role is skipped quietly when it isn't allowed (PowerUserAccess can't), but the attempt shows as an AccessDenied in the account's CloudTrail.
- **Unmanaged in ~/.aws** (the collapsed group at the bottom) lists every profile in your AWS files the app doesn't manage. **Adopt** one, or **Adopt all**, into a project. Names stay the same. A config section written as `[name]` (which the AWS CLI ignores, apart from `[default]`) becomes `[profile name]` with its settings kept. Keys are not touched.
- **Use a profile in a terminal.** *Settings → Terminal helper → Add to ~/.zshrc*, then in a new terminal: `awspm use <profile>`, `awspm ls`, `awspm off`, `awspm who`. Or use the **Use** button, which copies `export AWS_PROFILE=…`.

**Deleting** a project deletes its profiles too. The confirmation lists them and asks whether to also remove them from `~/.aws` (checked by default, with a backup first); unchecked, the files aren't touched and the profiles show up as unmanaged. Deleting a project that way also removes its SSO portal, unless another project's profiles still use it.

### Statuses

| Status | Meaning |
|---|---|
| Active | Valid. Time left is shown when known; `~` marks an estimate. |
| Expiring | Inside the warning window (15 min by default; *Settings*). |
| Expired | The sign-in ended, or STS says the keys expired. |
| Signed out | SSO profile whose portal has no sign-in. |
| No expiry | Long-lived IAM user keys. |
| Problem | AWS rejected the keys, or renewing plain keys failed. |

**How long an SSO sign-in lasts is detected, not configured.** AWS doesn't report it (it's your Identity Center admins' session setting). The app renews the sign-in in the background 20 minutes before each token expires. Near the end AWS still renews, but only up to the sign-in's end, so the app learns the exact end about 20 minutes ahead: the status turns *Expiring* with an exact countdown, and an alert offers to sign in again. Once it's over AWS refuses, and the status is *Expired*. A token past its expiry always shows *Expired* (if AWS hasn't answered yet, for example offline, the app retries every minute). Until the end is known, time left (`~`) counts from Identity Center's default 8-hour session, or from how long this portal's last sign-in lasted.

Alerts are macOS dialogs from the built-in `osascript`, so nothing needs to be installed. *Sign in again* / *Paste new keys* opens the app at that dialog in your default browser. *Ignore* silences that sign-in until the next one. Test it in *Settings*.

### When a file changes outside the app

Before each write, the app compares every managed section with what it last wrote. If you (or `aws configure`) edited one, the profile shows a warning and nothing is overwritten until you pick **Use file version** or **Restore AWS Profile Manager's version**. Sections the app doesn't manage are never rewritten. Before every write, the old file is copied to `~/.aws-profile-manager/backups/` (the newest 20 per file are kept).

## Security

- The service listens on `127.0.0.1` only and answers only this Mac's browser. The peer must be loopback, the `Host` header must be `localhost:5005`/`127.0.0.1:5005` (which blocks DNS rebinding), cross-site `Origin`s are refused, and the API takes JSON bodies only.
- **Keys and tokens never reach the browser.** The UI gets names, statuses and masked key IDs (`ASIA…WXYZ`). Pasted keys go UI → service once, then straight to `~/.aws/credentials`.
- No second copy of any secret: `~/.aws-profile-manager/store.json` holds projects, account labels, portal URLs, profile metadata and section hashes, never keys or tokens.
- Files the app writes are mode `600` and written in one step (temp file + rename); its directories are `700`.
- Request bodies, keys and tokens are never logged.
- The UI loads nothing from the internet and is served with a strict Content-Security-Policy.

## What's in here

```
server/                 Node service (CommonJS, Jest)
  index.js              entry: HTTP server + watcher
  service.js            launchd install / uninstall / status / restart
  core/                 paths, section-preserving INI editor, ~/.aws file access, store, validation
  sso/                  IAM Identity Center sign-in and the CLI token cache
  creds/                pasted-credentials parser, STS check
  domain/               projects, profiles, portals, status rules, the UI snapshot
  watcher/              30 s loop: token refresh, plain-key renewal, STS checks, alerts
  shell/                the `awspm` zsh helper
  http/                 request guards, POST /api operations, static UI
frontend/               React 18 + Vite + Tailwind
docs/superpowers/specs/ design
```

## Not yet supported

Assume-role (`role_arn`/`source_profile`) and `credential_process` profiles (listed, not adoptable), legacy SSO profiles without an `sso-session`, MFA, renaming profiles.
