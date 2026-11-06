'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempEnv, testContext, fakeSso } = require('../test/helpers');
const { SessionEndedError } = require('../sso/ssoService');
const { ValidationError } = require('../core/errors');

const DONE = {
    status: 'done',
    context: null,
    token: {
        startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1', accessToken: 'secret-access',
        expiresAt: '2026-11-05T13:00:00.123Z', refreshToken: 'secret-refresh', clientId: 'client-1', clientSecret: 'secret-client',
        registrationExpiresAt: '2027-02-03T12:00:00.000Z',
    },
};

describe('portals', () => {
    let t;
    afterEach(() => t.cleanup());

    test('signing in writes the CLI token cache, and only the status goes back to the UI', async () => {
        t = tempEnv();
        const sso = fakeSso();
        const ctx = testContext(t, { sso });
        const { id: portalId } = await ctx.portals.save({ name: 'Acme', startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        const started = await ctx.portals.startSignIn({ portalId });
        expect(started.userCode).toBe('ABCD-EFGH');
        expect(sso.startSignIn).toHaveBeenCalledWith('https://acme.awsapps.com/start', 'us-east-1', { portalId });

        sso.pollSignIn.mockResolvedValueOnce({ ...DONE, context: { portalId } });
        const polled = await ctx.portals.pollSignIn({ flowId: started.flowId });
        expect(polled).toEqual({ status: 'done' });

        const file = path.join(t.env.PROFILE_MANAGER_SSO_CACHE, `${crypto.createHash('sha1').update('acme').digest('hex')}.json`);
        const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(cached).toEqual({
            startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1', accessToken: 'secret-access', expiresAt: '2026-11-05T13:00:00Z',
            clientId: 'client-1', clientSecret: 'secret-client', registrationExpiresAt: '2027-02-03T12:00:00Z', refreshToken: 'secret-refresh',
        });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);

        const state = JSON.stringify(await ctx.state.compute());
        for (const secret of ['secret-access', 'secret-refresh', 'secret-client']) expect(state).not.toContain(secret);
    });

    test('a refused refresh ends the session; a refresh another tool just did does not', async () => {
        t = tempEnv();
        const sso = fakeSso({ refresh: jest.fn(async () => { throw new SessionEndedError(); }) });
        const ctx = testContext(t, { sso });
        const { id } = await ctx.portals.save({ name: 'Acme', startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        const nearExpiry = { ...DONE.token, expiresAt: new Date(Date.now() + 60e3).toISOString() };
        await ctx.tokens.write('acme', nearExpiry);
        await ctx.watcher.tick();
        // The last token still works for a minute: expiring, exactly; and the session length was learned.
        let portal = (await ctx.state.compute()).portals.find((p) => p.id === id);
        expect(portal.status).toMatchObject({ state: 'expiring', estimated: false });
        expect(portal.sessionMs).toBe(15 * 60e3);
        await ctx.watcher.tick();
        expect(sso.refresh).toHaveBeenCalledTimes(1); // an ended sign-in isn't retried

        // A fresh sign-in by another client (e.g. `aws sso login`) is picked up.
        await ctx.tokens.write('acme', { ...nearExpiry, clientId: 'aws-cli', expiresAt: new Date(Date.now() + 3600e3).toISOString() });
        await ctx.watcher.tick();
        portal = (await ctx.state.compute()).portals.find((p) => p.id === id);
        // A new session, counted down with the length learned from the last one (15 min here).
        expect(portal.status).toMatchObject({ state: 'expiring', estimated: true });
        expect(Date.parse(portal.status.expiresAt) - Date.now()).toBeGreaterThan(14 * 60e3);
    });

    test('a renewal capped at the sign-in end gives the exact end, and renewing stops', async () => {
        t = tempEnv();
        const endsAt = new Date(Date.now() + 18 * 60e3).toISOString();
        // Near the end AWS renews, but the new token expires when the sign-in does: no later than the old one.
        const sso = fakeSso({ refresh: jest.fn(async (token) => ({ ...token, accessToken: 'capped', expiresAt: endsAt })) });
        const ctx = testContext(t, { sso });
        const { id } = await ctx.portals.save({ name: 'Acme', startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        await ctx.tokens.write('acme', { ...DONE.token, expiresAt: endsAt });
        await ctx.watcher.tick();
        const portal = (await ctx.state.compute()).portals.find((p) => p.id === id);
        expect(portal.status).toMatchObject({ state: 'expiring', expiresAt: endsAt.replace(/\.\d{3}Z$/, '.000Z'), estimated: false });
        await ctx.watcher.tick();
        expect(sso.refresh).toHaveBeenCalledTimes(1);
    });

    test("a renewal that doesn't reach AWS is retried, and an expired token shows expired meanwhile", async () => {
        t = tempEnv();
        let now = Date.now();
        const offline = new ValidationError("AWS SSO couldn't renew the sign-in: ENOTFOUND");
        const sso = fakeSso({ refresh: jest.fn(async () => { throw offline; }) });
        const ctx = testContext(t, { sso, now: () => now });
        await ctx.portals.save({ name: 'Acme', startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        await ctx.tokens.write('acme', { ...DONE.token, expiresAt: new Date(now - 60e3).toISOString() });
        await ctx.watcher.tick();
        expect((await ctx.state.compute()).portals[0].status).toMatchObject({ state: 'expired', estimated: true });
        await ctx.watcher.tick();
        expect(sso.refresh).toHaveBeenCalledTimes(1); // not every 30 s
        now += 61e3;
        sso.refresh.mockImplementation(async (token) => ({ ...token, accessToken: 'back-online', expiresAt: new Date(now + 3600e3).toISOString() }));
        await ctx.watcher.tick();
        expect((await ctx.state.compute()).portals[0].status).toMatchObject({ state: 'active', estimated: true });
    });

    test('refresh race: the cache was renewed by someone else, so the session stays alive', async () => {
        t = tempEnv();
        let ctx;
        const sso = fakeSso({
            refresh: jest.fn(async () => {
                await ctx.tokens.write('acme', { ...DONE.token, accessToken: 'renewed-elsewhere', expiresAt: new Date(Date.now() + 3600e3).toISOString() });
                throw new SessionEndedError();
            }),
        });
        ctx = testContext(t, { sso });
        await ctx.portals.save({ name: 'Acme', startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        await ctx.tokens.write('acme', { ...DONE.token, expiresAt: new Date(Date.now() + 60e3).toISOString() });
        const portal = (await ctx.store.get()).portals[0];
        expect(await ctx.portals.accessToken(portal)).toBe('renewed-elsewhere');
        expect((await ctx.state.compute()).portals[0].status.state).not.toBe('expired');
    });

    test('a portal saved without a name is named after its project', async () => {
        t = tempEnv();
        const ctx = testContext(t);
        const { id: projectId } = await ctx.projects.createProject({ name: 'Acme' });
        await ctx.portals.save({ projectId, startUrl: 'https://d-1234567890.awsapps.com/start', region: 'us-east-1' });
        await ctx.portals.save({ startUrl: 'https://globex.awsapps.com/start', region: 'us-east-1' });
        const portals = (await ctx.state.compute()).portals;
        expect(portals.map((p) => [p.name, p.sessionName, p.projectId])).toEqual([['Acme SSO', 'acme-sso', projectId], ['globex', 'globex', null]]);
        expect(t.read('config')).toContain('[sso-session acme-sso]');
    });

    test("a new portal never takes over an [sso-session] the app doesn't manage", async () => {
        t = tempEnv();
        t.write('config', '[sso-session acme]\nsso_start_url = https://other.awsapps.com/start\nsso_region = eu-west-1\n');
        const ctx = testContext(t);
        await ctx.portals.save({ name: 'Acme', startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        const config = t.read('config');
        expect(config).toContain('[sso-session acme]\nsso_start_url = https://other.awsapps.com/start');
        expect(config).toContain('[sso-session acme-2]\nsso_start_url = https://acme.awsapps.com/start');
    });

    test('portals in use cannot be deleted; unused ones take their sso-session section with them', async () => {
        t = tempEnv();
        const ctx = testContext(t);
        const { id } = await ctx.portals.save({ name: 'Acme', startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        expect(t.read('config')).toContain('[sso-session acme]');
        await ctx.portals.remove({ id });
        expect(t.read('config')).not.toContain('sso-session acme');
    });
});
