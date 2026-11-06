'use strict';

const fs = require('node:fs');
const { probeDue } = require('./watcher');
const { tempEnv, testContext, seedProject, fakeSso, fakeNotifier } = require('../test/helpers');

const MIN = 60e3;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const at = (m) => new Date(NOW + m * MIN).toISOString();

describe('probeDue', () => {
    test.each([
        ['never checked', { temporary: true }, true],
        ['checked recently', { temporary: true, check: { at: at(-1), ok: true } }, false],
        ['checked 5+ min ago', { temporary: true, check: { at: at(-6), ok: true } }, true],
        ['2 min ago, far from the expected end', { temporary: true, expiresAt: at(40), check: { at: at(-2), ok: true } }, false],
        ['2 min ago, 8 min before the expected end: every minute now', { temporary: true, expiresAt: at(8), check: { at: at(-2), ok: true } }, true],
        ['the expected expiry just passed', { temporary: true, expiresAt: at(-1), check: { at: at(-2), ok: true } }, true],
        ['already known expired', { temporary: true, check: { at: at(-30), ok: false, code: 'expired' } }, false],
        ['long-lived, checked 30 min ago', { temporary: false, check: { at: at(-30), ok: true } }, false],
        ['long-lived, checked over an hour ago', { temporary: false, check: { at: at(-61), ok: true } }, true],
        ['long-lived and refused', { temporary: false, check: { at: at(-600), ok: false, code: 'invalid' } }, false],
    ])('%s', (_label, keys, due) => expect(probeDue(keys, NOW)).toBe(due));
});

describe('watcher notifications', () => {
    let t;
    afterEach(() => t.cleanup());

    test('notifies when keys move into the warning window and when they expire, not for stale state', async () => {
        t = tempEnv();
        let now = NOW;
        const notifier = fakeNotifier('dismissed');
        const ctx = testContext(t, { notifier, now: () => now });
        const { projectId } = await seedProject(ctx);
        const blob = 'aws_access_key_id=ASIAPASTEDPASTED0000\naws_secret_access_key=s\naws_session_token=t';
        await ctx.profiles.paste({ projectId, name: 'acme-prod-admin', blob }); // role unreadable → the 1 h default

        await ctx.watcher.tick(); // active: first sighting, nothing to say
        expect(notifier.prompt).not.toHaveBeenCalled();

        now += 50 * MIN; // 10 min left
        await ctx.watcher.tick();
        expect(notifier.prompt).toHaveBeenCalledTimes(1);
        expect(notifier.prompt.mock.calls[0][0].message).toMatch(/acme-prod-admin expire in ~10 min/);

        now += 1 * MIN;
        await ctx.watcher.tick(); // still expiring: no repeat
        expect(notifier.prompt).toHaveBeenCalledTimes(1);

        ctx.sts.check.mockResolvedValue({ ok: false, code: 'expired', message: 'These credentials have expired.' });
        now += 10 * MIN;
        await ctx.watcher.tick();
        expect(notifier.prompt).toHaveBeenCalledTimes(2);
        expect(notifier.prompt.mock.calls[1][0]).toMatchObject({ action: 'Paste new keys', message: expect.stringMatching(/have expired/) });
        expect(notifier.prompt.mock.calls[1][0].url).toMatch(/^http:\/\/localhost:5005\/#paste=/);
    });

    test('a fresh start does not announce profiles that expired long ago', async () => {
        t = tempEnv();
        const notifier = fakeNotifier('dismissed');
        const ctx = testContext(t, { notifier, now: () => NOW });
        const { projectId } = await seedProject(ctx);
        await ctx.profiles.paste({ projectId, name: 'acme-prod-admin', blob: 'aws_access_key_id=ASIAPASTEDPASTED0000\naws_secret_access_key=s\naws_session_token=t' });
        const later = testContext(t, { notifier, now: () => NOW + 180 * MIN });
        await later.watcher.tick();
        expect(notifier.prompt).not.toHaveBeenCalled();
    });

    test('a sign-in AWS says is ending, then ended: an alert to sign in again; estimates alone raise none', async () => {
        t = tempEnv();
        let now = Date.now(); // the token cache's file times are real
        const sso = fakeSso({ refresh: jest.fn(async (token) => ({ ...token, accessToken: 'fresh', expiresAt: new Date(now + 60 * MIN).toISOString() })) });
        const notifier = fakeNotifier('dismissed');
        const ctx = testContext(t, { sso, notifier, now: () => now });
        const { projectId } = await seedProject(ctx);
        const { id: portalId } = await ctx.portals.save({ name: 'Acme SSO', projectId, startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        await ctx.profiles.createSso({ portalId, projectId, region: 'us-east-1', accounts: [{ accountId: '111122223333', accountName: 'Acme Prod', label: 'Prod', color: 'red', roles: [{ roleName: 'AdministratorAccess', name: 'acme-prod-admin' }] }] });
        const token = { startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1', accessToken: 'a', refreshToken: 'r', clientId: 'mine', clientSecret: 's' };
        await ctx.tokens.write('acme-sso', { ...token, expiresAt: new Date(now + 50 * MIN).toISOString() });
        await ctx.watcher.tick();

        now += (8 * 60 - 10) * MIN; // the 8 h estimate is 10 min away: no alert for a guess
        await ctx.watcher.tick();
        expect((await ctx.state.compute()).portals[0].status).toMatchObject({ state: 'expiring', estimated: true });
        expect(notifier.prompt).not.toHaveBeenCalled();

        // AWS caps the next renewal at the sign-in's end: no later than the token it replaces.
        const endsAt = new Date(now + 18 * MIN).toISOString();
        await ctx.tokens.write('acme-sso', { ...token, expiresAt: endsAt });
        sso.refresh.mockImplementation(async (tk) => ({ ...tk, accessToken: 'capped', expiresAt: endsAt }));
        await ctx.watcher.tick();
        expect(notifier.prompt).toHaveBeenCalledTimes(1);
        expect(notifier.prompt.mock.calls[0][0]).toMatchObject({ title: 'Acme SSO', action: 'Sign in again', url: `http://localhost:5005/#sign-in=${portalId}` });
        expect(notifier.prompt.mock.calls[0][0].message).toMatch(/ends at .+, in 18 min\. 1 profile stops working then/);

        now += 19 * MIN;
        await ctx.watcher.tick();
        expect(notifier.prompt).toHaveBeenCalledTimes(2);
        expect(notifier.prompt.mock.calls[1][0].message).toBe('Your AWS sign-in has ended. 1 profile needs a new sign-in.');
    });

    test('"Ignore" silences the rest of that sign-in\'s alerts', async () => {
        t = tempEnv();
        let now = NOW;
        const sso = fakeSso({ refresh: jest.fn(async () => { throw new (require('../sso/ssoService').SessionEndedError)('InvalidRequestException'); }) });
        const notifier = fakeNotifier('ignore');
        const ctx = testContext(t, { sso, notifier, now: () => now });
        const { projectId } = await seedProject(ctx);
        const { id: portalId } = await ctx.portals.save({ name: 'Acme SSO', projectId, startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        await ctx.profiles.createSso({ portalId, projectId, region: 'us-east-1', accounts: [{ accountId: '111122223333', accountName: 'Acme Prod', label: 'Prod', color: 'red', roles: [{ roleName: 'AdministratorAccess', name: 'acme-prod-admin' }] }] });
        await ctx.tokens.write('acme-sso', { startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1', accessToken: 'a', refreshToken: 'r', clientId: 'mine', clientSecret: 's', expiresAt: new Date(NOW + 10 * MIN).toISOString() });
        await ctx.watcher.tick(); // refused: ends when the last token expires, in 10 min
        expect(notifier.prompt).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        now += 11 * MIN;
        await ctx.watcher.tick();
        expect((await ctx.state.compute()).portals[0].status).toMatchObject({ state: 'expired', estimated: false });
        expect(notifier.prompt).toHaveBeenCalledTimes(1);
    });

    test('writes profiles.tsv for the shell helper', async () => {
        t = tempEnv();
        const ctx = testContext(t);
        const { projectId } = await seedProject(ctx, { project: 'Acme' });
        await ctx.profiles.paste({ projectId, name: 'acme-prod-admin', accountLabel: 'Prod', accountColor: 'red', blob: 'aws_access_key_id=AKIAPASTEDPASTED0000\naws_secret_access_key=s' });
        await ctx.watcher.tick();
        expect(fs.readFileSync(ctx.paths.profilesTsv, 'utf8')).toBe('acme-prod-admin\tACME PROD ADMIN\t196\n');
    });
});
