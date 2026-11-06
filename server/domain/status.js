'use strict';

/**
 * What state every portal and profile is in, and how long it has left. Pure:
 * store records + token cache + the time in, statuses out.
 *
 * States: active · expiring · expired · signed-out · long-lived · unknown · error.
 * `expiresAt` is null when the end isn't known; `estimated` marks a countdown
 * the app worked out itself rather than read from AWS.
 */
const HOUR_MS = 3600 * 1000;
const QUARTER_MS = 15 * 60 * 1000;
// IAM Identity Center's default session length: the starting assumption until a portal's real one is detected.
const DEFAULT_SESSION_MS = 8 * HOUR_MS;

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

// Token expiry times are compared with this much play (rounding to seconds in the cache, clocks).
const END_SLACK_MS = 60 * 1000;

/**
 * The session length to remember after a sign-in lasted `observedMs` (to its
 * exact end, or still going at that age). The app signs in a moment after the
 * portal session starts, so it's rounded up: to whole hours (the usual setting),
 * or quarter hours below one.
 */
function snapSessionLength(observedMs) {
    if (observedMs > HOUR_MS) return Math.ceil(observedMs / HOUR_MS) * HOUR_MS;
    return Math.max(QUARTER_MS, Math.ceil(observedMs / QUARTER_MS) * QUARTER_MS);
}

/**
 * Whether the cached token comes from a sign-in the store hasn't recorded: one
 * done outside the app (`aws sso login` registers its own client), or a new
 * sign-in after the recorded one's end (no token outlives its sign-in).
 */
function isNewSession(session, cache) {
    if (!session?.signedInAt) return true;
    if (cache.token.clientId !== session.clientId) return true;
    return Boolean(session.endsAt && Date.parse(cache.token.expiresAt) > Date.parse(session.endsAt) + END_SLACK_MS);
}

function canRefresh(token) {
    return Boolean(token.refreshToken && token.clientId && token.clientSecret);
}

/**
 * A portal's sign-in. `cache` is the token cache entry (`{ token, mtime }`) or null.
 *
 * What AWS says precisely:
 *   - the access token's expiry. The app renews it 20 min early, so a token
 *     past its expiry means the sign-in couldn't be renewed: the CLI fails too.
 *   - the sign-in's end, once it's near: AWS caps renewed tokens at it, so a
 *     renewal that doesn't push the expiry out has reached it, to the second
 *     (`session.endsAt`, recorded by portals.refresh). A refused renewal ends
 *     it at the last token's expiry.
 * What it never says is the session length (an Identity Center admin setting).
 * Until the end is known, the countdown uses the length detected from this
 * portal's previous sign-ins (`portal.sessionMs`), or the 8-hour default.
 *
 * `estimated` marks what the app worked out rather than heard from AWS; alerts
 * only go out for what AWS confirmed.
 */
function portalStatus(portal, cache, nowMs, warnMs) {
    if (!cache) return { state: 'signed-out', expiresAt: null, estimated: false };
    const session = portal.session ?? null;
    const fresh = isNewSession(session, cache);
    const tokenExpires = Date.parse(cache.token.expiresAt);
    const signedInAt = fresh ? cache.mtime : Date.parse(session.signedInAt);
    const base = { signedInAt: iso(signedInAt), estimated: false };
    const ending = !fresh && Boolean(session.endsAt);
    const renewable = !ending && canRefresh(cache.token);

    if (tokenExpires <= nowMs) {
        // Not confirmed until AWS refuses a renewal: it may just be offline, and renew on the next try.
        return renewable
            ? { ...base, state: 'expired', expiresAt: null, since: iso(tokenExpires), estimated: true, note: "The sign-in couldn't be renewed yet (offline?). Retrying every minute." }
            : { ...base, state: 'expired', expiresAt: null, since: iso(tokenExpires) };
    }
    if (!renewable) {
        // AWS won't extend it: the token's own expiry is the end, to the second.
        const state = ending || tokenExpires - nowMs <= warnMs ? 'expiring' : 'active';
        return { ...base, state, expiresAt: iso(tokenExpires), ...(ending ? { note: 'AWS has stopped extending this sign-in. Sign in again to keep working.' } : {}) };
    }

    const detected = Boolean(portal.sessionMs);
    const endsAt = signedInAt + (portal.sessionMs ?? DEFAULT_SESSION_MS);
    if (endsAt <= nowMs) {
        return { ...base, state: 'active', expiresAt: null, estimated: true, note: 'Still signed in past the expected session length. AWS gives the exact end about 20 minutes before it.' };
    }
    const note = detected
        ? undefined
        : "Assumes IAM Identity Center's default 8-hour session. AWS doesn't report the real length, so it's detected when this sign-in ends and used from then on.";
    return { ...base, state: endsAt - nowMs <= warnMs ? 'expiring' : 'active', expiresAt: iso(endsAt), estimated: true, ...(note ? { note } : {}) };
}

const hours = (ms) => (ms % HOUR_MS === 0 ? `${ms / HOUR_MS} h` : `${Math.round(ms / 60000)} min`);

/** Where a pasted-keys countdown comes from, in words (creds/expiry.js). */
function expiryNote(keys) {
    if (!keys.lifetimeMs) return undefined;
    const length = hours(keys.lifetimeMs);
    if (keys.expiryBasis === 'role') return `This role's sessions last ${length} (read from the role), counted from when the keys were pasted.`;
    if (keys.expiryBasis === 'learned') return `Keys for this role lasted ${length} last time.`;
    return `AWS doesn't say when these keys expire, so this assumes the ${length} default for this kind of session. It's corrected when AWS reports them expired.`;
}

/** Pasted or adopted keys. */
function keysStatus(keys, nowMs, warnMs) {
    const check = keys?.check ?? null;
    const checkedAt = check ? Date.parse(check.at) : null;
    if (check && !check.ok && check.code === 'invalid') return { state: 'error', expiresAt: null, estimated: false, note: check.message };
    if (!keys?.temporary) {
        return { state: 'long-lived', expiresAt: null, estimated: false };
    }
    if (check && !check.ok && check.code === 'expired') {
        const since = keys.expiresAt && Date.parse(keys.expiresAt) < checkedAt ? keys.expiresAt : check.at;
        return { state: 'expired', expiresAt: null, since, estimated: false };
    }
    const expires = keys.expiresAt ? Date.parse(keys.expiresAt) : null;
    if (expires !== null) {
        if (expires <= nowMs) {
            // Past the expected end: a successful check after that point says the guess was short.
            if (check?.ok && checkedAt >= expires) return { state: 'active', expiresAt: null, estimated: true, note: 'Still valid past the expected expiry.' };
            return { state: 'expired', expiresAt: null, since: keys.expiresAt, estimated: true };
        }
        const note = expiryNote(keys);
        return { state: expires - nowMs <= warnMs ? 'expiring' : 'active', expiresAt: keys.expiresAt, estimated: true, ...(note ? { note } : {}) };
    }
    if (check?.ok) return { state: 'active', expiresAt: null, estimated: false };
    return { state: 'unknown', expiresAt: null, estimated: false };
}

/**
 * A managed profile. SSO profiles take their portal's status; plain keys
 * written for them add a note when their renewal failed.
 */
function profileStatus(profile, { portalStatuses, nowMs, warnMs }) {
    if (profile.kind === 'sso') {
        const base = portalStatuses.get(profile.sso?.portalId) ?? { state: 'signed-out', expiresAt: null, estimated: false };
        if (profile.sso?.exportKeys && profile.sso.keysError) return { ...base, note: `Plain keys: ${profile.sso.keysError}` };
        return base;
    }
    return keysStatus(profile.keys, nowMs, warnMs);
}

function summarise(statuses) {
    const counts = { active: 0, expiring: 0, expired: 0, attention: 0 };
    for (const s of statuses) {
        if (s.state === 'active' || s.state === 'long-lived') counts.active += 1;
        else if (s.state === 'expiring') counts.expiring += 1;
        else if (s.state === 'expired' || s.state === 'error') counts.expired += 1;
        if (s.state !== 'active' && s.state !== 'long-lived') counts.attention += 1;
    }
    return counts;
}

module.exports = { portalStatus, keysStatus, profileStatus, summarise, isNewSession, canRefresh, snapSessionLength, DEFAULT_SESSION_MS, END_SLACK_MS };
