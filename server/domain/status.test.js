'use strict';

const { portalStatus, keysStatus, profileStatus, summarise, snapSessionLength } = require('./status');

const NOW = Date.parse('2026-11-05T12:00:00Z');
const MIN = 60 * 1000;
const WARN = 15 * MIN;
const at = (offsetMin) => new Date(NOW + offsetMin * MIN).toISOString();

const token = (over = {}) => ({ accessToken: 'a', expiresAt: at(50), refreshToken: 'r', clientId: 'mine', clientSecret: 's', ...over });
const cache = (over = {}, mtimeOffsetMin = -60) => ({ token: token(over), mtime: NOW + mtimeOffsetMin * MIN });
const portal = (session, sessionMs = null) => ({ id: 'p', sessionMs, session });
const HOUR = 60 * MIN;

describe('portalStatus', () => {
    test('no cached token → signed out', () => {
        expect(portalStatus(portal(null), null, NOW, WARN).state).toBe('signed-out');
    });

    test('renewing, length not detected yet → counts down from the 8 h default, and says so', () => {
        const s = portalStatus(portal({ clientId: 'mine', signedInAt: at(-60) }), cache(), NOW, WARN);
        expect(s).toMatchObject({ state: 'active', expiresAt: at(7 * 60), estimated: true, signedInAt: at(-60) });
        expect(s.note).toMatch(/default 8-hour session/);
    });

    test('renewing with a detected session length → estimated countdown, no default note', () => {
        const s = portalStatus(portal({ clientId: 'mine', signedInAt: at(-60) }, 12 * HOUR), cache(), NOW, WARN);
        expect(s).toMatchObject({ state: 'active', expiresAt: at(11 * 60), estimated: true });
        expect(s.note).toBeUndefined();
        expect(portalStatus(portal({ clientId: 'mine', signedInAt: at(-8 * 60 + 10) }, 8 * HOUR), cache(), NOW, WARN))
            .toMatchObject({ state: 'expiring', expiresAt: at(10) });
    });

    test('the end is known → expiring, exactly until the last token expires, then expired', () => {
        const ending = portal({ clientId: 'mine', signedInAt: at(-480), endsAt: at(18) }, 8 * HOUR);
        expect(portalStatus(ending, cache({ expiresAt: at(18) }, -1), NOW, WARN))
            .toMatchObject({ state: 'expiring', expiresAt: at(18), estimated: false, note: expect.stringMatching(/stopped extending/) });
        expect(portalStatus(ending, cache({ expiresAt: at(-1) }, -40), NOW, WARN))
            .toMatchObject({ state: 'expired', since: at(-1), estimated: false });
    });

    test('an expired token is expired even with a refresh token; estimated until AWS refuses the renewal', () => {
        // The case that showed "Active" for a day: renewals failing, the token long expired.
        const s = portalStatus(portal({ clientId: 'mine', signedInAt: at(-16 * 60) }, 16 * HOUR), cache({ expiresAt: at(-14 * 60) }, -14 * 60), NOW, WARN);
        expect(s).toMatchObject({ state: 'expired', since: at(-14 * 60), estimated: true, note: expect.stringMatching(/offline/) });
    });

    test('a token that outlives the recorded end is a new sign-in', () => {
        const ended = portal({ clientId: 'mine', signedInAt: at(-600), endsAt: at(-100) }, 8 * HOUR);
        expect(portalStatus(ended, cache({}, -5), NOW, WARN)).toMatchObject({ state: 'active', expiresAt: at(-5 + 8 * 60), estimated: true });
    });

    test('a sign-in done outside the app (another client) starts a new session from the cache time', () => {
        const s = portalStatus(portal({ clientId: 'mine', signedInAt: at(-600), endsAt: at(-100) }, 8 * HOUR), cache({ clientId: 'cli' }, -30), NOW, WARN);
        expect(s).toMatchObject({ state: 'active', expiresAt: at(-30 + 8 * 60) });
    });

    test('a token without refresh → its own expiry is exact', () => {
        expect(portalStatus(portal(null), cache({ refreshToken: undefined, expiresAt: at(30) }), NOW, WARN))
            .toMatchObject({ state: 'active', expiresAt: at(30), estimated: false });
        expect(portalStatus(portal(null), cache({ refreshToken: undefined, expiresAt: at(-1) }), NOW, WARN).state).toBe('expired');
    });

    test('still renewing past the learned length → active without a countdown', () => {
        const s = portalStatus(portal({ clientId: 'mine', signedInAt: at(-9 * 60) }, 8 * HOUR), cache(), NOW, WARN);
        expect(s).toMatchObject({ state: 'active', expiresAt: null });
        expect(s.note).toMatch(/exact end about 20 minutes before/);
    });
});

describe('snapSessionLength', () => {
    test.each([
        [8 * HOUR - 40 * 1000, 8 * HOUR],
        [12 * HOUR - 5 * MIN, 12 * HOUR],
        [HOUR, HOUR],
        [50 * MIN, HOUR],
        [5 * MIN, 15 * MIN],
    ])('%d ms → %d ms', (observed, snapped) => expect(snapSessionLength(observed)).toBe(snapped));
});

describe('keysStatus', () => {
    test('long-lived keys', () => expect(keysStatus({ temporary: false }, NOW, WARN).state).toBe('long-lived'));
    test('unchecked temporary keys without an expiry → unknown', () => expect(keysStatus({ temporary: true }, NOW, WARN).state).toBe('unknown'));
    test('countdown from the expected expiry', () => {
        expect(keysStatus({ temporary: true, expiresAt: at(40) }, NOW, WARN)).toMatchObject({ state: 'active', expiresAt: at(40), estimated: true });
        expect(keysStatus({ temporary: true, expiresAt: at(5) }, NOW, WARN).state).toBe('expiring');
        expect(keysStatus({ temporary: true, expiresAt: at(-1) }, NOW, WARN)).toMatchObject({ state: 'expired', estimated: true });
    });
    test('STS has the last word', () => {
        expect(keysStatus({ temporary: true, expiresAt: at(30), check: { at: at(-1), ok: false, code: 'expired' } }, NOW, WARN).state).toBe('expired');
        expect(keysStatus({ temporary: true, expiresAt: at(-10), check: { at: at(-2), ok: true } }, NOW, WARN)).toMatchObject({ state: 'active', expiresAt: null });
        expect(keysStatus({ temporary: false, check: { at: at(-2), ok: false, code: 'invalid', message: 'bad' } }, NOW, WARN)).toMatchObject({ state: 'error', note: 'bad' });
        expect(keysStatus({ temporary: true, check: { at: at(-2), ok: true } }, NOW, WARN).state).toBe('active');
    });
});

describe('profileStatus', () => {
    test('SSO profiles take their portal status, with a note when plain keys failed', () => {
        const portalStatuses = new Map([['p', { state: 'active', expiresAt: at(60), estimated: true }]]);
        const profile = { kind: 'sso', sso: { portalId: 'p', exportKeys: true, keysError: 'boom' } };
        expect(profileStatus(profile, { portalStatuses, nowMs: NOW, warnMs: WARN })).toMatchObject({ state: 'active', note: 'Plain keys: boom' });
        expect(profileStatus({ kind: 'sso', sso: { portalId: 'gone' } }, { portalStatuses, nowMs: NOW, warnMs: WARN }).state).toBe('signed-out');
    });

    test('summarise counts', () => {
        expect(summarise([{ state: 'active' }, { state: 'long-lived' }, { state: 'expiring' }, { state: 'expired' }, { state: 'unknown' }]))
            .toEqual({ active: 2, expiring: 1, expired: 1, attention: 3 });
    });
});
