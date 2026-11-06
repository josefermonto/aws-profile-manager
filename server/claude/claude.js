'use strict';

/**
 * "Sync with Claude": makes Claude Code aware of the profiles, live.
 *
 * Nothing about the profiles is written into Claude's files. Turning sync on
 * installs three things that never change with them:
 *   - ~/.aws-profile-manager/bin/awspm-claude, a launcher for cli.js;
 *   - the skill ~/.claude/skills/aws-profiles/SKILL.md, which tells Claude to
 *     run `awspm-claude context` before AWS work: it answers with the profiles
 *     of the project the current folder is linked to, and their live status;
 *   - in ~/.claude/settings.json, a PreToolUse hook that runs every Bash
 *     command past policy.js, and a rule that lets the context command run
 *     without a prompt. The file is backed up first; only these entries change.
 * So a profile added or removed, or a sign-in that expires, reaches Claude the
 * next time it asks. Turning sync off removes exactly what was added.
 *
 * Folders are linked to projects (project.folders, `*` matches within one
 * folder name), so Claude only sees the profiles of the project it works on.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { ValidationError } = require('../core/errors');
const { readText, writeAtomic, ensureDir, backupText } = require('../core/fsx');
const { evaluate } = require('./policy');

const MARKER = 'Installed by AWS Profile Manager';
const CLI_NAME = 'awspm-claude';
const STATE_TEXT = {
    active: 'Active',
    expiring: 'Expiring',
    expired: 'Expired',
    'signed-out': 'Signed out',
    'long-lived': 'Active (long-lived keys)',
    unknown: 'Not checked yet',
    error: 'Problem',
};

const shellQuote = (s) => (/^[\w./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** `~/x`, `/abs/x`; `*` matches within one folder name. Matches the folder itself and everything below it. */
function folderRegex(pattern, home) {
    const absolute = pattern.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '');
    const body = absolute.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
    return new RegExp(`^${body}(?:/.*)?$`);
}

/** The project `cwd` belongs to: the most specific linked folder wins. `{ project, pattern }` or null. */
function projectForFolder(projects, cwd, home) {
    let best = null;
    for (const project of projects) {
        for (const pattern of project.folders ?? []) {
            if (folderRegex(pattern, home).test(cwd) && (!best || pattern.length > best.pattern.length)) best = { project, pattern };
        }
    }
    return best;
}

/** "~/x" for a folder under home. */
const tilde = (folder, home) => (folder === home || folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder);

function duration(ms) {
    const m = Math.max(1, Math.round(ms / 60000));
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

function table(rows) {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ')).join('\n');
}

function renderSkill(cli, appUrl) {
    const run = shellQuote(cli);
    return `---
name: aws-profiles
description: Use before running anything against real AWS accounts from this Mac (AWS CLI, CDK, SAM, Terraform, SDK scripts), to deploy, troubleshoot, read logs or inspect resources. Finds the right AWS profile for the current repo, with live sign-in status, from AWS Profile Manager.
---

<!-- ${MARKER}. It rewrites this file; edits here are lost. -->

# AWS profiles

AWS Profile Manager (${appUrl}) manages this Mac's AWS profiles. Before running anything against AWS:

1. Run \`${run} context\` from the repo. It lists the profiles of the project this folder belongs to: account, label (Prod, Dev...), role, region and live status. It never shows keys.
2. Pick the profile. Use the one the user named; otherwise the non-production one that fits the task, and say which. If several fit or none does, ask.
3. Name it on every command: \`--profile <name>\` for the AWS CLI, \`AWS_PROFILE=<name>\` before CDK, SAM, Terraform or scripts. Never rely on \`default\` or an inherited AWS_PROFILE.
4. If its status isn't Active or Expiring, don't run commands that will fail: tell the user it needs a new sign-in (or new keys) and give them the link from the output. Run \`${run} context\` again once they say it's done.
5. If the folder isn't linked to a project, the output lists project names only. Ask the user which project this repo belongs to, then run \`${run} link "<project>"\`.

Rules:
- Never read ~/.aws/credentials or ~/.aws/sso/cache, and never print keys or tokens.
- Before anything that changes resources in an account labeled Prod, say what will change and get the user's yes.
- Don't edit ~/.aws files or run \`aws configure set\`; profiles are managed in the app.
- A hook checks AWS commands before they run and explains when it stops one; follow what it says.
`;
}

function createClaude(ctx) {
    const { paths, store } = ctx;
    const skillFile = path.join(paths.claudeDir, 'skills', 'aws-profiles', 'SKILL.md');
    const settingsFile = path.join(paths.claudeDir, 'settings.json');
    const appUrl = `http://localhost:${ctx.port}`;
    const cli = paths.claudeCli;
    const contextCommand = `${shellQuote(cli)} context`;
    const hookCommand = `${shellQuote(cli)} hook`;
    const allowRule = `Bash(${contextCommand} *)`;
    const isOurs = (text) => typeof text === 'string' && text.includes(CLI_NAME);

    /** Each managed profile, as the hook and the context command see it. */
    async function profileFacts() {
        const snapshot = await ctx.state.compute();
        const projects = new Map(snapshot.projects.map((p) => [p.id, p]));
        const facts = new Map();
        for (const p of snapshot.profiles) {
            const account = snapshot.accounts[p.accountId] ?? {};
            const keys = p.kind === 'keys';
            facts.set(p.name, {
                profile: p,
                projectId: p.projectId,
                projectName: projects.get(p.projectId)?.name ?? 'none',
                label: account.label ?? '',
                account: [p.accountId, account.name].filter(Boolean).join(' ') || 'unknown account',
                state: p.status.state,
                fix: keys
                    ? `the keys have expired or were rejected. Ask the user to paste new ones: ${appUrl}/#paste=${p.id}`
                    : `the AWS sign-in has ended. Ask the user to sign in again: ${appUrl}/#sign-in=${p.sso?.portalId}`,
            });
        }
        return { snapshot, facts };
    }

    /** What `awspm-claude context` prints for `cwd`. */
    async function context(payload) {
        const cwd = absoluteFolder(payload?.cwd);
        const { snapshot, facts } = await profileFacts();
        const match = projectForFolder(snapshot.projects, cwd, paths.home);
        if (!match) {
            const names = snapshot.projects.map((p) => p.name);
            return {
                text: [
                    `This folder (${tilde(cwd, paths.home)}) isn't linked to a project in AWS Profile Manager, so no profiles are listed.`,
                    names.length ? `Projects: ${names.join(', ')}.` : 'There are no projects yet: the user adds them at ' + appUrl + '.',
                    names.length ? `Ask the user which project this repo belongs to, then run: ${shellQuote(cli)} link "<project>"` : '',
                ].filter(Boolean).join('\n'),
            };
        }
        const { project, pattern } = match;
        const nowMs = ctx.now();
        const rows = [['PROFILE', 'LABEL', 'ACCOUNT', 'ROLE', 'REGION', 'STATUS']];
        const notes = [];
        for (const f of facts.values()) {
            if (f.projectId !== project.id) continue;
            const { profile: p } = f;
            const left = p.status.expiresAt ? `, ${p.status.estimated ? '~' : ''}${duration(Date.parse(p.status.expiresAt) - nowMs)} left` : '';
            let status = `${STATE_TEXT[f.state] ?? f.state}${f.state === 'active' || f.state === 'expiring' ? left : ''}`;
            if (['expired', 'signed-out', 'error'].includes(f.state)) status += `: ${f.fix}`;
            else if (f.state === 'expiring' && p.kind === 'sso') status += `. Sign in again soon: ${appUrl}/#sign-in=${p.sso.portalId}`;
            rows.push([p.name, f.label || '-', f.account, p.label || '-', p.region, status]);
            if (p.kind === 'sso' && p.sso?.exportKeys) notes.push(`${p.name}-keys has the same access as plain keys in ~/.aws/credentials, for tools that can't use SSO profiles.`);
        }
        const lines = [
            `Project ${project.name} (this folder matches ${pattern}). Profiles from AWS Profile Manager, live:`,
            '',
            rows.length > 1 ? table(rows) : 'No profiles in this project yet: the user adds them at ' + appUrl + '.',
            ...(notes.length ? ['', ...notes] : []),
            '',
            'Name the profile on every command: --profile <name> (AWS CLI) or AWS_PROFILE=<name> (CDK, SAM, Terraform, scripts).',
            'Changes in an account labeled Prod need the user\'s OK first.',
        ];
        return { text: lines.join('\n') };
    }

    /** The PreToolUse verdict for one Bash command: `{ decision, reason }`. */
    async function hook(payload) {
        const s = await store.get();
        if (!s.settings.claudeSync) return { decision: null, reason: null };
        const command = typeof payload?.command === 'string' ? payload.command : '';
        const { snapshot, facts } = await profileFacts();
        const match = typeof payload?.cwd === 'string' && path.isAbsolute(payload.cwd) ? projectForFolder(snapshot.projects, payload.cwd, paths.home) : null;
        return evaluate(command, { profiles: facts, folderProject: match ? { id: match.project.id, name: match.project.name } : null }, { contextCommand });
    }

    /** `awspm-claude link "<project>"`: links a folder (the repo root) to a project by name. */
    async function link(payload) {
        const folder = absoluteFolder(payload?.folder);
        const name = String(payload?.project ?? '').trim().toLowerCase();
        const pattern = tilde(folder, paths.home);
        const project = await store.update((s) => {
            const found = s.projects.find((p) => p.name.toLowerCase() === name);
            if (!found) throw new ValidationError(`There's no project called "${payload?.project}". Projects: ${s.projects.map((p) => p.name).join(', ') || 'none yet'}.`);
            for (const p of s.projects) p.folders = (p.folders ?? []).filter((f) => f !== pattern);
            found.folders.push(pattern);
            return found;
        });
        return { text: `Linked ${pattern} to ${project.name}. Run ${contextCommand} to see its profiles.` };
    }

    /** What's installed: the UI shows it next to the toggle. */
    async function status() {
        const s = await store.get();
        const skill = await readText(skillFile);
        const settings = await readSettings().catch(() => ({}));
        const hookInstalled = (settings.hooks?.PreToolUse ?? []).some((g) => (g.hooks ?? []).some((h) => isOurs(h.command)));
        return {
            sync: s.settings.claudeSync,
            skill: Boolean(skill && skill.includes(MARKER)),
            hook: hookInstalled,
            skillFile,
            settingsFile,
            cli,
        };
    }

    async function readSettings() {
        const text = await readText(settingsFile);
        if (!text || !text.trim()) return {};
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new ValidationError(`${settingsFile} isn't valid JSON, so it was left alone. Fix it, then try again.`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ValidationError(`${settingsFile} isn't a JSON object, so it was left alone.`);
        return parsed;
    }

    /** `settings` without this app's entries, plus them again when `on`. */
    function withEntries(settings, on) {
        const next = structuredClone(settings);
        if (Array.isArray(next.hooks?.PreToolUse)) {
            next.hooks.PreToolUse = next.hooks.PreToolUse
                .map((g) => (Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h.command)) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h.command)) } : g))
                .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
            if (!next.hooks.PreToolUse.length) delete next.hooks.PreToolUse;
            if (!Object.keys(next.hooks).length) delete next.hooks;
        }
        if (Array.isArray(next.permissions?.allow)) {
            next.permissions.allow = next.permissions.allow.filter((rule) => !isOurs(rule));
            if (!next.permissions.allow.length) delete next.permissions.allow;
            if (!Object.keys(next.permissions).length) delete next.permissions;
        }
        if (on) {
            next.hooks ??= {};
            next.hooks.PreToolUse ??= [];
            next.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] });
            next.permissions ??= {};
            next.permissions.allow ??= [];
            next.permissions.allow.push(allowRule);
        }
        return next;
    }

    async function writeSettings(on) {
        const current = await readSettings();
        const next = withEntries(current, on);
        if (JSON.stringify(next) === JSON.stringify(current)) return;
        const text = await readText(settingsFile);
        if (text) await backupText(paths.backups, 'claude-settings', text, new Date(ctx.now()));
        const mode = await fs.stat(settingsFile).then((st) => st.mode & 0o777).catch(() => 0o600);
        await ensureDir(paths.claudeDir);
        await writeAtomic(settingsFile, `${JSON.stringify(next, null, 2)}\n`, mode);
    }

    /** The launcher and the skill: rewritten on every start (the Node or repo path may have moved). */
    async function writeOwnFiles() {
        const node = shellQuote(process.execPath);
        const script = shellQuote(path.join(__dirname, 'cli.js'));
        await ensureDir(path.dirname(cli));
        await writeAtomic(cli, `#!/bin/sh\n# ${MARKER}: lets Claude Code ask it about AWS profiles.\nPROFILE_MANAGER_PORT=${ctx.port} exec ${node} ${script} "$@"\n`, 0o755);
        const existing = await readText(skillFile);
        if (existing && !existing.includes(MARKER)) {
            throw new ValidationError(`There's already a skill called aws-profiles (${skillFile}) that this app didn't write. Rename or remove it, then try again.`);
        }
        await ensureDir(path.dirname(skillFile));
        await writeAtomic(skillFile, renderSkill(cli, appUrl), 0o644);
    }

    async function removeOwnFiles() {
        const existing = await readText(skillFile);
        if (existing?.includes(MARKER)) await fs.rm(path.dirname(skillFile), { recursive: true, force: true });
        const launcher = await readText(cli);
        if (launcher?.includes(MARKER)) await fs.rm(cli, { force: true });
    }

    /** Turns sync on or off (the toggle). */
    async function setSync(payload) {
        const on = payload?.on === true;
        if (on) {
            await writeOwnFiles();
            await writeSettings(true);
        } else {
            await writeSettings(false);
            await removeOwnFiles();
        }
        await store.update((s) => {
            s.settings.claudeSync = on;
        });
        return status();
    }

    /** At start: keeps the launcher and skill current when sync is on. Never touches settings.json. */
    async function ensure() {
        const s = await store.get();
        if (s.settings.claudeSync) await writeOwnFiles();
    }

    return { context, hook, link, status, setSync, ensure, contextCommand };
}

/** An absolute folder path, as sent by the CLI. */
function absoluteFolder(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 1000 || /[\0\n\r]/.test(value)) {
        throw new ValidationError('Send the folder as an absolute path.');
    }
    return path.resolve(value);
}

module.exports = { createClaude, projectForFolder, folderRegex, renderSkill, MARKER };
