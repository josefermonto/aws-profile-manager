'use strict';

/**
 * SSO portals: saving them (as [sso-session] sections), signing in and out,
 * keeping the token fresh, and listing the accounts and roles a sign-in can use.
 *
 * The token goes straight into the CLI's cache (sso/tokenCache.js); the
 * browser only ever learns whether the sign-in is done.
 */
const { ValidationError } = require('../core/errors');
const { sessionSection, listProfiles } = require('../core/awsFiles');
const { newId, slug } = require('../core/names');
const { SessionEndedError } = require('../sso/ssoService');
const { canRefresh, isNewSession, snapSessionLength, END_SLACK_MS } = require('./status');
const { sessionPatch } = require('./profiles');
const v = require('../core/validate');

// Renew the access token this long before it expires (the SDK waits until 5 minutes). AWS caps renewed
// tokens at the sign-in's end, so renewing early finds that end ~20 min ahead: an exact warning.
const REFRESH_BEFORE_MS = 20 * 60 * 1000;

function createPortals(ctx) {
    const { store, files, tokens, sso } = ctx;
    const nowIso = () => new Date(ctx.now()).toISOString();

    function findPortal(s, id) {
        const portal = s.portals.find((p) => p.id === id);
        if (!portal) throw new ValidationError('That portal no longer exists.');
        return portal;
    }

    /** A session name no other portal uses and that isn't already an [sso-session] in the config. */
    async function uniqueSessionName(s, name) {
        const existing = new Set(Object.keys(listProfiles(await files.readBoth()).sessions));
        const taken = (candidate) => s.portals.some((p) => p.sessionName === candidate) || existing.has(candidate);
        const base = slug(name) || 'sso';
        let candidate = base;
        for (let i = 2; taken(candidate); i += 1) candidate = `${base}-${i}`;
        return candidate;
    }

    function discoverRegion(payload) {
        return sso.discoverRegion(v.startUrl(payload?.startUrl));
    }

    /** The name a portal gets when none is typed: "<Project> SSO", else its portal subdomain. */
    function defaultName(s, projectId, startUrl) {
        const project = s.projects.find((p) => p.id === projectId);
        if (project) return `${project.name} SSO`;
        const sub = new URL(startUrl).hostname.split('.')[0];
        return /^d-[0-9a-f]+$/i.test(sub) ? 'SSO' : sub;
    }

    function save(payload) {
        const typedName = v.text(payload?.name, 'Portal name', { max: 60, optional: true });
        const startUrl = v.startUrl(payload?.startUrl);
        const region = v.region(payload?.region, 'SSO region');
        const projectId = payload?.projectId ? v.id(payload.projectId, 'Project') : null;
        return store.update(async (s) => {
            if (projectId && !s.projects.some((p) => p.id === projectId)) throw new ValidationError('That project no longer exists.');
            const name = typedName ?? defaultName(s, projectId, startUrl);
            let portal;
            if (payload?.id) {
                portal = findPortal(s, v.id(payload.id, 'Portal'));
                const moved = portal.startUrl !== startUrl || portal.region !== region;
                Object.assign(portal, { name, startUrl, region, projectId });
                if (moved) {
                    // A sign-in belongs to one portal: neither it nor what was learned about it carries over.
                    await tokens.remove(portal.sessionName);
                    portal.session = null;
                    portal.sessionMs = null;
                }
            } else {
                if (s.portals.some((p) => p.startUrl === startUrl)) throw new ValidationError('That portal is already saved.');
                portal = { id: newId(), name, projectId, startUrl, region, sessionName: await uniqueSessionName(s, name), sessionMs: null, session: null };
                s.portals.push(portal);
            }
            await files.apply([{ file: 'config', section: sessionSection(portal.sessionName), patch: sessionPatch(portal) }]);
            return { id: portal.id };
        });
    }

    function remove(payload) {
        const id = v.id(payload?.id, 'Portal');
        return store.update(async (s) => {
            const portal = findPortal(s, id);
            const used = s.profiles.filter((p) => p.kind === 'sso' && p.sso.portalId === id).length;
            if (used) throw new ValidationError(`Remove this portal's ${used} profile${used === 1 ? '' : 's'} first.`);
            await tokens.remove(portal.sessionName);
            await files.apply([{ file: 'config', section: sessionSection(portal.sessionName), remove: true }]);
            s.portals = s.portals.filter((p) => p.id !== id);
            return { id };
        });
    }

    async function startSignIn(payload) {
        const portal = findPortal(await store.get(), v.id(payload?.portalId, 'Portal'));
        return sso.startSignIn(portal.startUrl, portal.region, { portalId: portal.id });
    }

    /** `{ status }` only: the token itself never leaves the server. */
    async function pollSignIn(payload) {
        const result = await sso.pollSignIn(v.id(payload?.flowId, 'Sign-in'));
        if (result.status !== 'done') return { status: result.status, slowDown: result.slowDown ?? false };
        await store.update(async (s) => {
            const portal = findPortal(s, result.context.portalId);
            await tokens.write(portal.sessionName, result.token);
            portal.session = { clientId: result.token.clientId, signedInAt: nowIso(), endsAt: null };
        });
        ctx.watcher?.poke();
        return { status: 'done' };
    }

    async function signOut(payload) {
        const id = v.id(payload?.portalId, 'Portal');
        const portal = findPortal(await store.get(), id);
        const cache = await tokens.read(portal.sessionName);
        if (cache) await sso.logout(cache.token.accessToken, portal.region);
        await tokens.remove(portal.sessionName);
        await store.update((s) => {
            const p = s.portals.find((x) => x.id === id);
            if (p) p.session = null;
        });
        ctx.watcher?.poke();
        return { id };
    }

    /**
     * Records when the sign-in stops working (`endsAtMs`, exact), and learns the
     * portal's session length from it (see status.snapSessionLength).
     */
    async function markEnding(portal, cache, endsAtMs) {
        await store.update((s) => {
            const p = s.portals.find((x) => x.id === portal.id);
            if (!p) return;
            const sameSession = !isNewSession(p.session, cache);
            if (sameSession && p.session.endsAt) return;
            const signedInAt = sameSession ? Date.parse(p.session.signedInAt) : cache.mtime;
            p.session = { clientId: cache.token.clientId, signedInAt: new Date(signedInAt).toISOString(), endsAt: new Date(endsAtMs).toISOString() };
            p.sessionMs = snapSessionLength(endsAtMs - signedInAt);
        });
    }

    /**
     * Renews the cached token with its refresh token.
     *
     * Near the sign-in's end AWS still renews, but caps the new token at that
     * end; a renewal that doesn't push the expiry out has found it. Once it's
     * over AWS refuses, and the last token works until its own expiry. A refusal
     * can also mean another tool (the CLI, an SDK) renewed it a moment earlier
     * and AWS rotated the refresh token, so the cache is re-read first.
     */
    async function refresh(portal, cache) {
        let next;
        try {
            next = await sso.refresh(cache.token);
        } catch (error) {
            if (!(error instanceof SessionEndedError)) throw error;
            const latest = await tokens.read(portal.sessionName);
            if (latest && latest.token.accessToken !== cache.token.accessToken && Date.parse(latest.token.expiresAt) > ctx.now()) return latest.token;
            await markEnding(portal, cache, Date.parse(cache.token.expiresAt));
            throw error;
        }
        await tokens.write(portal.sessionName, next);
        const endsAt = Date.parse(next.expiresAt);
        if (endsAt <= Date.parse(cache.token.expiresAt) + END_SLACK_MS) await markEnding(portal, { token: next, mtime: cache.mtime }, endsAt);
        return next;
    }

    /** A usable access token for the portal, renewed first when it's close to expiring. */
    async function accessToken(portal) {
        const cache = await tokens.read(portal.sessionName);
        if (!cache) throw new ValidationError(`Sign in to ${portal.name} first.`);
        const expires = Date.parse(cache.token.expiresAt);
        if (expires - ctx.now() > REFRESH_BEFORE_MS) return cache.token.accessToken;
        const ending = portal.session?.endsAt && !isNewSession(portal.session, cache);
        if (ending || !canRefresh(cache.token)) {
            if (expires > ctx.now()) return cache.token.accessToken;
            throw new SessionEndedError();
        }
        return (await refresh(portal, cache)).accessToken;
    }

    /** Accounts and roles, each role with the managed profiles that already use it. */
    async function listAccounts(payload) {
        const s = await store.get();
        const portal = findPortal(s, v.id(payload?.portalId, 'Portal'));
        const { accounts } = await sso.listAccounts(await accessToken(portal), portal.region);
        const existing = s.profiles.filter((p) => p.kind === 'sso' && p.sso.portalId === portal.id);
        return {
            accounts: accounts.map((a) => ({
                ...a,
                roles: a.roles.map((roleName) => ({
                    roleName,
                    profiles: existing.filter((p) => p.accountId === a.accountId && p.sso.roleName === roleName).map((p) => p.name),
                })),
            })),
        };
    }

    return { discoverRegion, save, remove, startSignIn, pollSignIn, signOut, accessToken, refresh, listAccounts, REFRESH_BEFORE_MS };
}

module.exports = { createPortals, REFRESH_BEFORE_MS };
