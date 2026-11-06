'use strict';

/**
 * ~/.aws/config and ~/.aws/credentials: reading every profile in them, and
 * editing only the sections the app manages.
 *
 * Every write re-reads the file first, so edits made outside the app to other
 * sections are never lost. A managed section that changed outside the app
 * since it was last written is a conflict: the write is refused unless forced.
 * Before each write the old file is copied to the backups directory.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const ini = require('./ini');
const { readText, writeAtomic, ensureDir, createLock } = require('./fsx');
const { ConflictError } = require('./errors');

const MAX_BACKUPS = 20;
const FILES = ['config', 'credentials'];

/** The config-file section for a profile (the CLI reads `[default]` and `[profile x]` only). */
const configSection = (name) => (name === 'default' ? 'default' : `profile ${name}`);
const sessionSection = (name) => `sso-session ${name}`;

const maskKeyId = (id) => (id && id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : null);

/**
 * Every profile named in either file. Values are raw and may include secrets:
 * use describeProfile() for anything that leaves the server.
 */
function listProfiles(files) {
    const byName = new Map();
    const entry = (name) => {
        if (!byName.has(name)) byName.set(name, { name, config: null, bareConfig: null, credentials: null });
        return byName.get(name);
    };
    const sessions = {};
    const view = (s) => ({ section: s.name, values: ini.values(s), fingerprint: ini.fingerprint(s) });

    for (const s of files.config.doc.sections) {
        if (s.name === 'default') entry('default').config = view(s);
        else if (s.name.startsWith('profile ')) entry(s.name.slice('profile '.length)).config = view(s);
        else if (s.name.startsWith('sso-session ')) sessions[s.name.slice('sso-session '.length)] = view(s);
        else if (!s.name.includes(' ')) entry(s.name).bareConfig = view(s);
    }
    for (const s of files.credentials.doc.sections) entry(s.name).credentials = view(s);
    return { profiles: [...byName.values()], sessions };
}

/** What kind of profile this is, judged from its settings. */
function profileKind(p) {
    const c = p.config?.values ?? p.bareConfig?.values ?? {};
    const k = p.credentials?.values ?? {};
    if (c.sso_session) return 'sso';
    if (c.sso_start_url) return 'sso-legacy';
    if (c.role_arn) return 'assume-role';
    if (c.credential_process) return 'process';
    if (k.aws_access_key_id && k.aws_secret_access_key) return 'keys';
    return 'other';
}

/** A profile as the UI may see it: no secret values. */
function describeProfile(p) {
    const c = p.config?.values ?? p.bareConfig?.values ?? {};
    const k = p.credentials?.values ?? {};
    const warnings = [];
    if (p.bareConfig && !p.config && p.name !== 'default') {
        warnings.push(`Its config section is [${p.name}] instead of [profile ${p.name}], so the AWS CLI ignores its region and other settings.`);
    }
    return {
        name: p.name,
        kind: profileKind(p),
        temporary: Boolean(k.aws_session_token || k.aws_security_token),
        keyId: maskKeyId(k.aws_access_key_id),
        region: c.region ?? null,
        ssoSession: c.sso_session ?? null,
        accountId: c.sso_account_id ?? null,
        roleName: c.sso_role_name ?? null,
        inConfig: Boolean(p.config || p.bareConfig),
        inCredentials: Boolean(p.credentials),
        warnings,
    };
}

function createAwsFiles({ paths, now = () => new Date() }) {
    const lock = createLock();

    async function read(kind) {
        const file = paths[kind];
        const text = (await readText(file)) ?? '';
        return { file, text, doc: ini.parse(text) };
    }

    async function readBoth() {
        const [config, credentials] = await Promise.all([read('config'), read('credentials')]);
        return { config, credentials };
    }

    async function backup(kind, text) {
        await ensureDir(paths.backups);
        const stamp = now().toISOString().replace(/[:.]/g, '-');
        await writeAtomic(path.join(paths.backups, `${kind}.${stamp}.bak`), text);
        const old = (await fs.readdir(paths.backups)).filter((f) => f.startsWith(`${kind}.`) && f.endsWith('.bak')).sort();
        for (const f of old.slice(0, Math.max(0, old.length - MAX_BACKUPS))) {
            await fs.rm(path.join(paths.backups, f), { force: true });
        }
    }

    /**
     * Applies section edits: `{ file, section, patch?, replaces?, remove?, expect? }`.
     * `patch` sets/removes keys (creating the section if needed), `replaces`
     * renames another section into this one, `remove` deletes the section.
     * `expect` is the fingerprint the section had when the app last wrote it
     * (null = it must not exist yet); a mismatch is a conflict unless `force`.
     *
     * Resolves to `{ 'config:profile x': fingerprint | null, … }` for the edited sections.
     */
    function apply(edits, { force = false } = {}) {
        return lock(async () => {
            const files = await readBoth();
            if (!force) {
                const conflicts = [];
                for (const e of edits) {
                    if (e.expect === undefined) continue;
                    const current = ini.fingerprint(ini.find(files[e.file].doc, e.section));
                    if (current !== e.expect) conflicts.push({ file: e.file, section: e.section, missing: current === null });
                }
                if (conflicts.length) {
                    const list = conflicts.map((c) => `[${c.section}] in ${c.file}`).join(', ');
                    throw new ConflictError(`Changed outside AWS Profile Manager since it was last saved: ${list}.`, conflicts);
                }
            }
            const result = {};
            for (const kind of FILES) {
                const mine = edits.filter((e) => e.file === kind);
                if (!mine.length) continue;
                const { file, text, doc } = files[kind];
                for (const e of mine) {
                    if (e.remove) {
                        ini.remove(doc, e.section);
                        result[`${kind}:${e.section}`] = null;
                    } else {
                        const section = ini.upsert(doc, e.section, e.patch ?? {}, e.replaces ?? null);
                        result[`${kind}:${e.section}`] = ini.fingerprint(section);
                    }
                }
                const next = ini.serialize(doc);
                if (next !== text) {
                    if (text) await backup(kind, text);
                    await writeAtomic(file, next);
                }
            }
            return result;
        });
    }

    return { readBoth, apply };
}

module.exports = { createAwsFiles, listProfiles, describeProfile, profileKind, configSection, sessionSection, maskKeyId };
