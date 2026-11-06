'use strict';

/**
 * The background loop (every 30 s, and soon after any change):
 *
 *   1. Portals: notice sign-ins done outside the app, notice sign-outs, and
 *      renew access tokens 20 min before they expire. Each renewal asks AWS:
 *      near the end it caps the new token at the sign-in's end (the exact end),
 *      and once it's over it refuses.
 *   2. SSO profiles with "also write plain keys": renew <name>-keys before it expires.
 *   3. Keys: check with STS. Pasted (temporary) keys every 5 min, every minute
 *      near the expected end, and right after it; long-lived keys hourly.
 *   4. Alert on changes: a macOS dialog with the fix one click away (sign in
 *      again, paste new keys) or Ignore. Only for what AWS confirmed for sign-ins.
 *   5. Keep the shell helper's profiles.tsv current.
 */
const { isNewSession, canRefresh, DEFAULT_SESSION_MS } = require('../domain/status');
const { keysProfileName, promptTag, roleSlug } = require('../core/names');

const INTERVAL_MS = 30 * 1000;
const HOUR_MS = 3600 * 1000;
const PROBE_EVERY_MS = 5 * 60 * 1000;
const LONG_LIVED_EVERY_MS = HOUR_MS;
// In the last minutes before pasted keys are expected to expire, check every minute, so the real end is caught.
const NEAR_END_MS = 10 * 60 * 1000;
const PROBE_NEAR_END_MS = 60 * 1000;
const RETRY_AFTER_MS = 2 * 60 * 1000;
// A renewal that didn't reach AWS (offline, a 5xx) is retried this often.
const REFRESH_RETRY_MS = 60 * 1000;
const KEYS_RENEW_BEFORE_MS = 10 * 60 * 1000;
const MAX_PROBES_PER_TICK = 10;

/** Whether keys are due an STS check. */
function probeDue(keys, nowMs) {
    const check = keys?.check;
    if (!check) return true;
    if (!check.ok && (check.code === 'expired' || check.code === 'invalid')) return false;
    const at = Date.parse(check.at);
    if (!keys.temporary) return nowMs - at >= LONG_LIVED_EVERY_MS;
    const expires = keys.expiresAt ? Date.parse(keys.expiresAt) : null;
    if (expires !== null && expires <= nowMs && at < expires) return true;
    const nearEnd = expires !== null && expires > nowMs && expires - nowMs <= NEAR_END_MS;
    return nowMs - at >= (nearEnd ? PROBE_NEAR_END_MS : PROBE_EVERY_MS);
}

const minutesLeft = (iso, nowMs) => Math.max(1, Math.round((Date.parse(iso) - nowMs) / 60000));
const clock = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listNames = (names) => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`);
// A state as the alerts see it: 'expiring' from AWS and an estimated 'expiring~' are different news.
const seen = (status) => `${status.state}${status.estimated ? '~' : ''}`;

function createWatcher(ctx, { intervalMs = INTERVAL_MS, log = console } = {}) {
    const lastStates = new Map(); // 'portal:<id>' | 'profile:<id>' → state seen on the previous tick
    const lastAttempt = new Map(); // profile id → ms of the last STS check / key renewal attempt
    const refreshFailedAt = new Map(); // portal id → ms of the last renewal that didn't reach AWS
    const ignored = new Set(); // alert subjects the user answered "Ignore" to
    let timer = null;
    let pokeTimer = null;
    let running = null;

    async function syncPortals() {
        const s = await ctx.store.get();
        for (const portal of s.portals) {
            const cache = await ctx.tokens.read(portal.sessionName);
            if (!cache) {
                if (portal.session) {
                    // Signed out elsewhere (`aws sso logout`) or the cache was cleared.
                    await ctx.store.update((d) => {
                        const p = d.portals.find((x) => x.id === portal.id);
                        if (p) p.session = null;
                    });
                }
                continue;
            }
            let session = portal.session;
            if (isNewSession(session, cache)) {
                session = { clientId: cache.token.clientId, signedInAt: new Date(cache.mtime).toISOString(), endsAt: null };
                await ctx.store.update((d) => {
                    const p = d.portals.find((x) => x.id === portal.id);
                    if (p) p.session = session;
                });
            }
            if (session.endsAt) continue; // AWS won't extend it: nothing left to renew
            const nowMs = ctx.now();
            // Past the expected length (detected, or the 8 h default) with a token AWS keeps renewing: it's longer than that.
            const age = nowMs - Date.parse(session.signedInAt);
            if (Date.parse(cache.token.expiresAt) > nowMs && age >= (portal.sessionMs ?? DEFAULT_SESSION_MS) + HOUR_MS) {
                await ctx.store.update((d) => {
                    const p = d.portals.find((x) => x.id === portal.id);
                    if (p) p.sessionMs = Math.floor(age / HOUR_MS) * HOUR_MS;
                });
            }
            const due = Date.parse(cache.token.expiresAt) - nowMs <= ctx.portals.REFRESH_BEFORE_MS;
            if (!due || !canRefresh(cache.token) || nowMs - (refreshFailedAt.get(portal.id) ?? 0) < REFRESH_RETRY_MS) continue;
            try {
                await ctx.portals.refresh({ ...portal, session }, cache);
                refreshFailedAt.delete(portal.id);
            } catch (error) {
                if (error.name === 'SessionEndedError') continue;
                refreshFailedAt.set(portal.id, nowMs);
                log.error(`portal renewal didn't reach AWS: ${error.code ?? error.name}`);
            }
        }
    }

    async function renewKeys(statuses) {
        const s = await ctx.store.get();
        for (const profile of s.profiles) {
            if (profile.kind !== 'sso' || !profile.sso?.exportKeys) continue;
            const due = !profile.sso.keysExpireAt || Date.parse(profile.sso.keysExpireAt) - ctx.now() <= KEYS_RENEW_BEFORE_MS;
            if (!due) continue;
            const portalState = statuses.portals.find((p) => p.id === profile.sso.portalId)?.status.state;
            if (portalState !== 'active' && portalState !== 'expiring') continue;
            if (profile.sso.keysError && ctx.now() - (lastAttempt.get(profile.id) ?? 0) < RETRY_AFTER_MS) continue;
            lastAttempt.set(profile.id, ctx.now());
            try {
                await ctx.profiles.writeExportedKeys(profile.id);
            } catch (error) {
                log.error(`plain-key renewal failed for a profile: ${error.name}`);
            }
        }
    }

    async function probeKeys() {
        const s = await ctx.store.get();
        const nowMs = ctx.now();
        const due = s.profiles.filter(
            (p) => p.kind === 'keys' && probeDue(p.keys, nowMs) && nowMs - (lastAttempt.get(p.id) ?? 0) >= PROBE_NEAR_END_MS,
        );
        for (const profile of due.slice(0, MAX_PROBES_PER_TICK)) {
            lastAttempt.set(profile.id, nowMs);
            await ctx.profiles.probe(profile.id);
        }
    }

    /**
     * Compares this tick's states with the last and raises one alert per change:
     * a sign-in AWS says is ending or has ended, keys expiring or expired.
     * `key` names the subject (one sign-in, one batch of keys): "Ignore" silences
     * it, and a newer alert about it replaces one still on screen.
     */
    async function notify(snapshot) {
        const nowMs = ctx.now();
        const events = [];
        const transition = (key, state) => {
            const previous = lastStates.get(key);
            lastStates.set(key, state);
            return previous;
        };
        for (const portal of snapshot.portals) {
            const { status } = portal;
            const previous = transition(`portal:${portal.id}`, seen(status));
            if (!portal.profileCount || previous === seen(status) || status.estimated) continue;
            const one = portal.profileCount === 1;
            const profiles = plural(portal.profileCount, 'profile');
            const base = { key: `portal:${portal.id}:${status.signedInAt}`, title: portal.name, action: 'Sign in again', url: `#sign-in=${portal.id}` };
            if (status.state === 'expiring') {
                events.push({ ...base, message: `Your AWS sign-in ends at ${clock(status.expiresAt)}, in ${minutesLeft(status.expiresAt, nowMs)} min. ${profiles} ${one ? 'stops' : 'stop'} working then.` });
            } else if (status.state === 'expired' && previous && !previous.startsWith('signed-out')) {
                events.push({ ...base, message: `Your AWS sign-in has ended. ${profiles} ${one ? 'needs' : 'need'} a new sign-in.` });
            }
        }
        const expiring = [];
        const expired = [];
        for (const profile of snapshot.profiles) {
            if (profile.kind !== 'keys') continue;
            const previous = transition(`profile:${profile.id}`, profile.status.state);
            if (previous === profile.status.state) continue;
            if (profile.status.state === 'expiring') expiring.push(profile);
            else if (profile.status.state === 'expired' && previous && previous !== 'unknown') expired.push(profile);
        }
        const keysAlert = (list, message) => ({
            key: `keys:${list.map((p) => `${p.id}@${p.keys?.expiresAt ?? ''}`).sort().join(',')}`,
            title: 'AWS Profile Manager',
            message,
            action: 'Paste new keys',
            url: list.length === 1 ? `#paste=${list[0].id}` : '#',
        });
        if (expiring.length) {
            const soonest = Math.min(...expiring.map((p) => minutesLeft(p.status.expiresAt, nowMs)));
            events.push(keysAlert(expiring, `Keys for ${listNames(expiring.map((p) => p.name))} expire in ~${soonest} min. Paste new ones to keep working.`));
        }
        if (expired.length) events.push(keysAlert(expired, `Keys for ${listNames(expired.map((p) => p.name))} have expired.`));
        if (!snapshot.settings.notifications) return events;
        for (const e of events) {
            if (ignored.has(e.key)) continue;
            // Not awaited: the dialog stays up until it's answered.
            void ctx.notifier.prompt({ ...e, url: `http://localhost:${ctx.port}/${e.url}` }).then((answer) => {
                if (answer === 'ignore') ignored.add(e.key);
            });
        }
        return events;
    }

    async function writeShellData(snapshot) {
        const projects = new Map(snapshot.projects.map((p) => [p.id, p]));
        const rows = [];
        for (const profile of snapshot.profiles) {
            // [ACME PROD ADMIN]: project, the account's label (or name), the role.
            const account = snapshot.accounts[profile.accountId] ?? {};
            const role = roleSlug(profile.kind === 'sso' ? profile.sso.roleName : profile.label || 'keys');
            const tag = promptTag(projects.get(profile.projectId)?.name, account.label || account.name, role);
            rows.push({ name: profile.name, tag, color: account.color });
            if (profile.kind === 'sso' && profile.sso?.exportKeys) rows.push({ name: keysProfileName(profile.name), tag: promptTag(tag, 'keys'), color: account.color });
        }
        for (const p of snapshot.unmanaged) rows.push({ name: p.name, tag: '', color: null });
        await ctx.shell.writeProfiles(rows.sort((a, b) => a.name.localeCompare(b.name)));
    }

    async function runTick() {
        await syncPortals();
        await renewKeys(await ctx.state.compute());
        await probeKeys();
        const snapshot = await ctx.state.compute();
        await notify(snapshot);
        await writeShellData(snapshot);
    }

    /** One pass; concurrent callers share the pass already running. */
    function tick() {
        if (!running) {
            running = runTick()
                .catch((error) => log.error(`watcher tick failed: ${error.name}: ${error.message}`))
                .finally(() => {
                    running = null;
                });
        }
        return running;
    }

    /** Runs a pass soon (after a change), coalescing bursts of changes into one. */
    function poke() {
        clearTimeout(pokeTimer);
        pokeTimer = setTimeout(() => void tick(), 300);
    }

    function start() {
        void tick();
        timer = setInterval(() => void tick(), intervalMs);
    }

    function stop() {
        clearInterval(timer);
        clearTimeout(pokeTimer);
    }

    return { start, stop, tick, poke, notify, probeDue };
}

module.exports = { createWatcher, probeDue };
