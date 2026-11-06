'use strict';

/**
 * Managed profiles: adopting existing ones, pasting keys, creating SSO
 * profiles, editing, removing, resolving outside edits, and checking keys.
 *
 * Each operation edits only this profile's own sections in ~/.aws (see
 * core/awsFiles.js) and records their fingerprints, so a later outside edit
 * shows up as a conflict instead of being overwritten.
 */
const { ValidationError } = require('../core/errors');
const { listProfiles, profileKind, configSection, sessionSection } = require('../core/awsFiles');
const { newId, keysProfileName, NEW_PROFILE_NAME_RE, EXISTING_PROFILE_NAME_RE } = require('../core/names');
const { parseCreds } = require('../creds/parseCreds');
const { detectLifetime, snapLifetime } = require('../creds/expiry');
const v = require('../core/validate');
const { ENV_COLORS } = require('./colors');

const KIND_LABEL = { 'sso-legacy': 'legacy SSO (no sso-session)', 'assume-role': 'assume-role', process: 'credential_process', other: 'settings-only' };
const NAME_RULE = 'Use letters, digits, dots, dashes and underscores (64 at most), starting with a letter or digit.';

const credentialsPatch = (c) => ({
    aws_access_key_id: c.accessKeyId,
    aws_secret_access_key: c.secretAccessKey,
    aws_session_token: c.sessionToken || null,
    aws_security_token: null,
});

const sessionPatch = (portal) => ({
    sso_start_url: portal.startUrl,
    sso_region: portal.region,
    sso_registration_scopes: 'sso:account:access',
});

const ssoProfilePatch = (profile, portal) => ({
    sso_session: portal.sessionName,
    sso_account_id: profile.accountId,
    sso_role_name: profile.sso.roleName,
    region: profile.region,
    output: profile.output ?? 'json',
});

/**
 * The file edits that delete a managed profile from ~/.aws: its config section,
 * its keys, and the <name>-keys sibling written for "also write plain keys".
 */
function removalEdits(profile) {
    const edits = [{ file: 'config', section: configSection(profile.name), remove: true }];
    if (profile.kind === 'keys') edits.push({ file: 'credentials', section: profile.name, remove: true });
    if (profile.kind === 'sso' && profile.sso?.exportKeys) {
        const sibling = keysProfileName(profile.name);
        edits.push({ file: 'credentials', section: sibling, remove: true }, { file: 'config', section: configSection(sibling), remove: true });
    }
    return edits;
}

/** The keys stored for a profile in ~/.aws/credentials, or null. Stays on the server. */
function keysFromFiles(files, name) {
    const found = listProfiles(files).profiles.find((p) => p.name === name);
    const k = found?.credentials?.values;
    if (!k?.aws_access_key_id || !k?.aws_secret_access_key) return null;
    return { accessKeyId: k.aws_access_key_id, secretAccessKey: k.aws_secret_access_key, sessionToken: k.aws_session_token || k.aws_security_token || null };
}

function createProfiles(ctx) {
    const { store, files } = ctx;
    const nowIso = () => new Date(ctx.now()).toISOString();
    const poke = (result) => {
        ctx.watcher?.poke();
        return result;
    };

    function findProfile(s, id) {
        const profile = s.profiles.find((p) => p.id === id);
        if (!profile) throw new ValidationError('That profile is no longer managed.');
        return profile;
    }

    function findProject(s, projectId) {
        const project = s.projects.find((p) => p.id === projectId);
        if (!project) throw new ValidationError('Pick a project for the profile.');
        return project;
    }

    /**
     * Records what's known about an AWS account: its name, and the label and
     * color shown for it (shared by every profile in that account).
     */
    function setAccount(s, accountId, { name, label, color } = {}) {
        if (!accountId) return;
        const current = s.accounts[accountId] ?? { name: null, label: '', color: null };
        s.accounts[accountId] = {
            name: name ?? current.name,
            label: label === undefined ? current.label : v.text(label, 'Label', { max: 30, optional: true }) ?? '',
            color: color === undefined ? current.color : color === null ? null : v.oneOf(color, 'Color', ENV_COLORS),
        };
    }

    function assertNewName(name, s, listed, pending = []) {
        if (!NEW_PROFILE_NAME_RE.test(name)) throw new ValidationError(`"${name}" can't be used as a profile name. ${NAME_RULE}`);
        if (s.profiles.some((p) => p.name === name || (p.kind === 'sso' && p.sso?.exportKeys && keysProfileName(p.name) === name)) || pending.includes(name)) {
            throw new ValidationError(`A profile named ${name} is already managed.`);
        }
        if (listed.profiles.some((p) => p.name === name)) {
            throw new ValidationError(`A profile named ${name} is already in your AWS files. Adopt it from Unmanaged profiles, or pick another name.`);
        }
    }

    function checkRecord(result) {
        return { at: nowIso(), ok: result.ok, code: result.ok ? null : result.code, message: result.ok ? null : result.message };
    }

    /** Takes over profiles that already exist in the files (see Unmanaged profiles). */
    function adopt(payload) {
        const items = v.array(payload?.items, 'Profiles', { max: 200 });
        return store.update(async (s) => {
            const { profiles: listed, sessions } = listProfiles(await files.readBoth());
            const byName = new Map(listed.map((p) => [p.name, p]));
            const edits = [];
            const created = [];
            for (const item of items) {
                const name = v.text(item?.name, 'Profile name', { max: 128, re: EXISTING_PROFILE_NAME_RE });
                const project = findProject(s, item?.projectId);
                if (s.profiles.some((p) => p.name === name) || created.some((p) => p.name === name)) throw new ValidationError(`${name} is already managed.`);
                const found = byName.get(name);
                if (!found) throw new ValidationError(`There's no profile named ${name} in your AWS files any more.`);
                const kind = profileKind(found);
                const c = found.config?.values ?? found.bareConfig?.values ?? {};
                const k = found.credentials?.values ?? {};
                const section = configSection(name);

                // A bare [name] section in config is ignored by the CLI: renaming it to [profile name] makes its settings count.
                if (found.bareConfig && !found.config && name !== 'default') edits.push({ file: 'config', section, replaces: name, patch: {} });
                else if (!found.config && !found.bareConfig) edits.push({ file: 'config', section, patch: { region: 'us-east-1', output: 'json' } });

                const profile = {
                    id: newId(), name, projectId: project.id,
                    label: '',
                    region: c.region ?? 'us-east-1', output: c.output ?? 'json',
                    accountId: null, fingerprints: {}, createdAt: nowIso(),
                };
                if (kind === 'sso') {
                    let portal = s.portals.find((p) => p.sessionName === c.sso_session);
                    if (!portal) {
                        const sv = sessions[c.sso_session]?.values;
                        if (!sv?.sso_start_url || !sv?.sso_region) {
                            throw new ValidationError(`${name} uses sso_session ${c.sso_session}, but there's no complete [sso-session ${c.sso_session}] section.`);
                        }
                        portal = { id: newId(), name: c.sso_session, startUrl: sv.sso_start_url, region: sv.sso_region, sessionName: c.sso_session, projectId: project.id, sessionMs: null, session: null };
                        s.portals.push(portal);
                    }
                    profile.kind = 'sso';
                    profile.accountId = c.sso_account_id ?? null;
                    setAccount(s, profile.accountId);
                    profile.sso = { portalId: portal.id, roleName: c.sso_role_name ?? '', exportKeys: false, keysExpireAt: null, keysError: null };
                    profile.label ||= profile.sso.roleName;
                } else if (kind === 'keys') {
                    profile.kind = 'keys';
                    profile.keys = { temporary: Boolean(k.aws_session_token || k.aws_security_token), pastedAt: null, expiresAt: null, check: null };
                } else {
                    throw new ValidationError(`${name} is a ${KIND_LABEL[kind]} profile, which AWS Profile Manager can't manage yet.`);
                }
                created.push(profile);
            }
            if (edits.length) await files.apply(edits);
            const after = edits.length ? listProfiles(await files.readBoth()).profiles : listed;
            for (const profile of created) {
                const f = after.find((x) => x.name === profile.name);
                profile.fingerprints = { config: f?.config?.fingerprint ?? null, credentials: f?.credentials?.fingerprint ?? null };
                s.profiles.push(profile);
            }
            return { ids: created.map((p) => p.id) };
        }).then(poke);
    }

    /**
     * Pasted keys: new keys for an existing keys profile (`profileId`), or a
     * new profile in a project. The keys are checked with STS first, so
     * expired or wrong ones are refused before anything is written, and how
     * long they last is worked out from the session that issued them (creds/expiry.js).
     */
    async function paste(payload) {
        const parsed = parseCreds(v.text(payload?.blob, 'Credentials', { max: 10000 }));
        if (!parsed.accessKeyId || !parsed.secretAccessKey) throw new ValidationError(parsed.warnings.join(' ') || 'No AWS credentials found.');
        const result = await ctx.sts.check(parsed);
        if (!result.ok && result.code !== 'unreachable') throw new ValidationError(result.message);

        const temporary = Boolean(parsed.sessionToken);
        const lifetime = temporary
            ? await detectLifetime(result, (await store.get()).learnedKeyLifetimes, (roleName) => ctx.sts.roleMaxSession(parsed, roleName))
            : null;
        const keys = {
            temporary,
            pastedAt: nowIso(),
            expiresAt: lifetime ? new Date(ctx.now() + lifetime.ms).toISOString() : null,
            lifetimeMs: lifetime?.ms ?? null,
            expiryBasis: lifetime?.basis ?? null,
            lifetimeKey: lifetime?.key ?? null,
            check: checkRecord(result),
        };
        const warnings = parsed.warnings.filter((w) => !w.startsWith('Missing aws_session_token') || temporary);
        if (!result.ok) warnings.push(result.message);

        const id = await store.update(async (s) => {
            if (payload?.profileId) {
                const profile = findProfile(s, v.id(payload.profileId, 'Profile'));
                if (profile.kind !== 'keys') throw new ValidationError(`${profile.name} is an SSO profile; sign in to its portal instead.`);
                // New keys replace whatever is in the file: pasting is an explicit overwrite.
                const fp = await files.apply([{ file: 'credentials', section: profile.name, patch: credentialsPatch(parsed) }]);
                profile.fingerprints.credentials = fp[`credentials:${profile.name}`];
                profile.keys = keys;
                if (result.ok) profile.accountId = result.accountId;
                setAccount(s, profile.accountId);
                return profile.id;
            }
            const project = findProject(s, payload?.projectId);
            const name = v.text(payload?.name, 'Profile name', { max: 64 });
            assertNewName(name, s, listProfiles(await files.readBoth()));
            const profile = {
                id: newId(), name, projectId: project.id, kind: 'keys',
                label: result.ok ? result.principal ?? '' : parsed.roleName ?? '',
                region: v.region(payload?.region ?? 'us-east-1'),
                output: 'json',
                accountId: result.ok ? result.accountId : parsed.accountId ?? null,
                keys,
                fingerprints: {},
                createdAt: nowIso(),
            };
            setAccount(s, profile.accountId, { label: payload?.accountLabel, color: payload?.accountColor });
            const fp = await files.apply([
                { file: 'config', section: configSection(name), patch: { region: profile.region, output: 'json' }, expect: null },
                { file: 'credentials', section: name, patch: credentialsPatch(parsed), expect: null },
            ]);
            profile.fingerprints = { config: fp[`config:${configSection(name)}`], credentials: fp[`credentials:${name}`] };
            s.profiles.push(profile);
            return profile.id;
        });
        return poke({
            id, warnings,
            accountId: result.ok ? result.accountId : null,
            principal: result.ok ? result.principal : null,
            expiresAt: keys.expiresAt,
            lifetimeMs: keys.lifetimeMs,
            expiryBasis: keys.expiryBasis,
        });
    }

    /**
     * New SSO profiles from a portal, many accounts at once:
     * `accounts: [{ accountId, accountName, label, color, roles: [{ roleName, name }] }]`.
     * Each account's label and color are saved for the account, shared by its profiles.
     */
    function createSso(payload) {
        const portalId = v.id(payload?.portalId, 'Portal');
        const accounts = v.array(payload?.accounts, 'Accounts', { max: 300 });
        return store.update(async (s) => {
            const portal = s.portals.find((p) => p.id === portalId);
            if (!portal) throw new ValidationError('That portal no longer exists.');
            const project = findProject(s, payload?.projectId);
            const region = v.region(payload?.region ?? 'us-east-1');
            const listed = listProfiles(await files.readBoth());
            const edits = [{ file: 'config', section: sessionSection(portal.sessionName), patch: sessionPatch(portal) }];
            const created = [];
            for (const account of accounts) {
                const accountId = v.text(account?.accountId, 'Account ID', { re: v.ACCOUNT_ID_RE, reMessage: 'Account IDs are 12 digits.' });
                setAccount(s, accountId, {
                    name: v.text(account?.accountName, 'Account name', { max: 128, optional: true }) ?? undefined,
                    label: account?.label ?? undefined,
                    color: account?.color ?? undefined,
                });
                for (const role of v.array(account?.roles, 'Roles', { max: 50 })) {
                    const name = v.text(role?.name, 'Profile name', { max: 64 });
                    assertNewName(name, s, listed, created.map((p) => p.name));
                    const roleName = v.text(role?.roleName, 'Role', { re: v.ROLE_NAME_RE });
                    const profile = {
                        id: newId(), name, projectId: project.id, kind: 'sso',
                        label: roleName,
                        accountId,
                        region,
                        output: 'json',
                        sso: { portalId, roleName, exportKeys: payload?.exportKeys === true, keysExpireAt: null, keysError: null },
                        fingerprints: {},
                        createdAt: nowIso(),
                    };
                    edits.push({ file: 'config', section: configSection(name), patch: ssoProfilePatch(profile, portal), expect: null });
                    created.push(profile);
                }
            }
            if (!created.length) throw new ValidationError('Pick at least one role to add.');
            const fp = await files.apply(edits);
            for (const profile of created) {
                profile.fingerprints.config = fp[`config:${configSection(profile.name)}`];
                s.profiles.push(profile);
            }
            return { ids: created.map((p) => p.id) };
        }).then(poke);
    }

    function keysSiblingEdits(name, region) {
        const sibling = keysProfileName(name);
        if (region === null) return [{ file: 'credentials', section: sibling, remove: true }, { file: 'config', section: configSection(sibling), remove: true }];
        return [{ file: 'config', section: configSection(sibling), patch: { region, output: 'json' } }];
    }

    /** Project, region, and "also write plain keys" for SSO. */
    function update(payload) {
        const id = v.id(payload?.id, 'Profile');
        return store.update(async (s) => {
            const profile = findProfile(s, id);
            const edits = [];
            if (payload.projectId !== undefined) profile.projectId = findProject(s, payload.projectId).id;
            if (payload.region !== undefined) {
                const region = v.region(payload.region);
                if (region !== profile.region) {
                    profile.region = region;
                    edits.push({ file: 'config', section: configSection(profile.name), patch: { region }, expect: profile.fingerprints.config ?? undefined });
                    if (profile.kind === 'sso' && profile.sso.exportKeys) edits.push(...keysSiblingEdits(profile.name, region));
                }
            }
            if (profile.kind === 'sso' && payload.exportKeys !== undefined && (payload.exportKeys === true) !== profile.sso.exportKeys) {
                profile.sso.exportKeys = payload.exportKeys === true;
                if (!profile.sso.exportKeys) {
                    edits.push(...keysSiblingEdits(profile.name, null));
                    profile.sso.keysExpireAt = null;
                    profile.sso.keysError = null;
                }
            }
            if (edits.length) {
                const fp = await files.apply(edits);
                profile.fingerprints.config = fp[`config:${configSection(profile.name)}`] ?? profile.fingerprints.config;
            }
            return { id };
        }).then(poke);
    }

    /** Stops managing a profile; with `deleteFromFiles`, also removes its sections from ~/.aws (a backup is kept). */
    function remove(payload) {
        const id = v.id(payload?.id, 'Profile');
        return store.update(async (s) => {
            const profile = findProfile(s, id);
            if (payload?.deleteFromFiles === true) await files.apply(removalEdits(profile));
            s.profiles = s.profiles.filter((p) => p.id !== id);
            return { id };
        });
    }

    /**
     * A managed section changed outside the app. 'accept' takes the file's
     * version as the new baseline; 'restore' rewrites the config section from
     * the app's data. Keys can only be accepted: the app keeps no copy of them.
     */
    function resolveConflict(payload) {
        const id = v.id(payload?.id, 'Profile');
        const action = v.oneOf(payload?.action, 'Action', ['accept', 'restore']);
        return store.update(async (s) => {
            const profile = findProfile(s, id);
            const found = listProfiles(await files.readBoth()).profiles.find((p) => p.name === profile.name);
            if (action === 'accept') {
                if (!found?.config && !found?.credentials) {
                    s.profiles = s.profiles.filter((p) => p.id !== id);
                    return { id, removed: true };
                }
                const c = found.config?.values ?? {};
                if (c.region) profile.region = c.region;
                if (profile.kind === 'sso') {
                    profile.accountId = c.sso_account_id ?? profile.accountId;
                    profile.sso.roleName = c.sso_role_name ?? profile.sso.roleName;
                }
                const credsChanged = profile.kind === 'keys' && (found.credentials?.fingerprint ?? null) !== (profile.fingerprints.credentials ?? null);
                if (credsChanged) {
                    const k = found.credentials?.values ?? {};
                    profile.keys = { temporary: Boolean(k.aws_session_token || k.aws_security_token), pastedAt: null, expiresAt: null, check: null };
                }
                profile.fingerprints = { config: found.config?.fingerprint ?? null, credentials: found.credentials?.fingerprint ?? null };
                return { id };
            }
            if (profile.kind === 'keys' && (found?.credentials?.fingerprint ?? null) !== (profile.fingerprints.credentials ?? null)) {
                throw new ValidationError("The keys in ~/.aws/credentials changed outside the app. It keeps no copy of keys, so accept the file's version or paste new keys.");
            }
            const portal = profile.kind === 'sso' ? s.portals.find((p) => p.id === profile.sso.portalId) : null;
            const patch = profile.kind === 'sso' ? ssoProfilePatch(profile, portal) : { region: profile.region, output: profile.output ?? 'json' };
            const fp = await files.apply([{ file: 'config', section: configSection(profile.name), patch }], { force: true });
            profile.fingerprints.config = fp[`config:${configSection(profile.name)}`];
            return { id };
        });
    }

    /**
     * Checks a keys profile with STS and records the result. The first time STS
     * says pasted keys have expired, how long they lasted is learned for their
     * role, so the next paste for it gets the right expiry. Returns the check.
     */
    async function probe(id) {
        const snapshot = await store.get();
        const profile = snapshot.profiles.find((p) => p.id === id);
        if (!profile || profile.kind !== 'keys') return null;
        const keys = keysFromFiles(await files.readBoth(), profile.name);
        const result = keys
            ? await ctx.sts.check(keys)
            : { ok: false, code: 'invalid', message: 'There are no keys for this profile in ~/.aws/credentials.' };
        if (!result.ok && result.code === 'unreachable') return result;
        await store.update((s) => {
            const p = s.profiles.find((x) => x.id === id);
            if (!p) return;
            const wasValid = p.keys.check?.ok !== false;
            if (result.ok === false && result.code === 'expired' && wasValid && p.keys.pastedAt && p.keys.lifetimeKey) {
                s.learnedKeyLifetimes[p.keys.lifetimeKey] = snapLifetime(ctx.now() - Date.parse(p.keys.pastedAt));
            }
            p.keys.check = checkRecord(result);
            if (keys) p.keys.temporary = Boolean(keys.sessionToken);
            if (result.ok) {
                p.accountId ||= result.accountId;
                p.label ||= result.principal ?? '';
            }
        });
        return result;
    }

    /** Fetches role credentials for an SSO profile with "also write plain keys" and writes them to <name>-keys. */
    async function writeExportedKeys(id) {
        const snapshot = await store.get();
        const profile = snapshot.profiles.find((p) => p.id === id);
        if (!profile || profile.kind !== 'sso' || !profile.sso.exportKeys) return null;
        const portal = snapshot.portals.find((p) => p.id === profile.sso.portalId);
        if (!portal) return null;
        try {
            const token = await ctx.portals.accessToken(portal);
            const { credentials, expiresAt } = await ctx.sso.roleCredentials(token, portal.region, profile.accountId, profile.sso.roleName);
            const sibling = keysProfileName(profile.name);
            await files.apply([
                { file: 'credentials', section: sibling, patch: credentialsPatch(credentials) },
                ...keysSiblingEdits(profile.name, profile.region),
            ]);
            await store.update((s) => {
                const p = s.profiles.find((x) => x.id === id);
                if (p?.sso) Object.assign(p.sso, { keysExpireAt: expiresAt, keysError: null });
            });
            return { expiresAt };
        } catch (error) {
            await store.update((s) => {
                const p = s.profiles.find((x) => x.id === id);
                if (p?.sso) p.sso.keysError = error instanceof ValidationError ? error.message : 'Renewal failed.';
            });
            throw error;
        }
    }

    async function checkNow(payload) {
        const id = v.id(payload?.id, 'Profile');
        const snapshot = await store.get();
        const profile = findProfile(snapshot, id);
        if (profile.kind === 'keys') {
            const result = await probe(id);
            if (result && !result.ok && result.code === 'unreachable') throw new ValidationError(result.message);
        } else if (profile.sso.exportKeys) {
            await writeExportedKeys(id);
        }
        await ctx.watcher?.tick();
        return { id };
    }

    return { adopt, paste, createSso, update, remove, resolveConflict, probe, writeExportedKeys, checkNow };
}

module.exports = { createProfiles, keysFromFiles, credentialsPatch, sessionPatch, ssoProfilePatch, removalEdits };
