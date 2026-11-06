'use strict';

const fs = require('node:fs');
const { tempEnv, testContext, seedProject } = require('../test/helpers');

const CONFIG = '[default]\nregion = us-east-1\n';
const CREDENTIALS = '[default]\naws_access_key_id = AKIADEFAULTDEFAULT00\naws_secret_access_key = default-secret\n';
const blob = (n) => `aws_access_key_id=ASIAPASTEDPASTED000${n}\naws_secret_access_key=s${n}\naws_session_token=t${n}`;

describe('projects and accounts', () => {
    let t;
    let ctx;
    beforeEach(() => {
        t = tempEnv();
        t.write('config', CONFIG);
        t.write('credentials', CREDENTIALS);
        ctx = testContext(t);
    });
    afterEach(() => t.cleanup());

    async function acmeWithProfiles() {
        const { projectId } = await seedProject(ctx, { project: 'Acme' });
        await ctx.profiles.paste({ projectId, name: 'acme-prod-deploy', blob: blob(1) });
        const { id: portalId } = await ctx.portals.save({ projectId, startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        await ctx.tokens.write('acme-sso', { startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1', accessToken: 'a', expiresAt: new Date(Date.now() + 3600e3).toISOString(), refreshToken: 'r', clientId: 'c', clientSecret: 's' });
        await ctx.profiles.createSso({
            portalId, projectId, exportKeys: true,
            accounts: [{ accountId: '111122223333', roles: [{ roleName: 'AdministratorAccess', name: 'acme-prod-admin' }] }],
        });
        await ctx.profiles.writeExportedKeys((await ctx.store.get()).profiles.find((p) => p.name === 'acme-prod-admin').id);
        return { projectId, portalId };
    }

    test('one SSO add can take many accounts, each with its own label and color', async () => {
        const { projectId } = await seedProject(ctx, { project: 'Acme' });
        const { id: portalId } = await ctx.portals.save({ projectId, startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        const r = await ctx.profiles.createSso({
            portalId, projectId, region: 'eu-west-1',
            accounts: [
                { accountId: '111111111111', accountName: 'acme-dev', label: 'Dev', color: 'green', roles: [{ roleName: 'AdministratorAccess', name: 'acme-dev-admin' }, { roleName: 'ReadOnlyAccess', name: 'acme-dev-readonly' }] },
                { accountId: '222222222222', accountName: 'acme-prod', label: 'Prod', color: 'red', roles: [{ roleName: 'ReadOnlyAccess', name: 'acme-prod-readonly' }] },
            ],
        });
        expect(r.ids).toHaveLength(3);
        const state = await ctx.state.compute();
        expect(state.accounts).toEqual({
            111111111111: { name: 'acme-dev', label: 'Dev', color: 'green' },
            222222222222: { name: 'acme-prod', label: 'Prod', color: 'red' },
        });
        expect(state.profiles.map((p) => [p.name, p.projectId, p.accountId, p.region])).toEqual([
            ['acme-dev-admin', projectId, '111111111111', 'eu-west-1'],
            ['acme-dev-readonly', projectId, '111111111111', 'eu-west-1'],
            ['acme-prod-readonly', projectId, '222222222222', 'eu-west-1'],
        ]);
        expect(t.read('config')).toContain('[profile acme-prod-readonly]\nsso_session = acme-sso\nsso_account_id = 222222222222\nsso_role_name = ReadOnlyAccess\nregion = eu-west-1\n');
    });

    test("an account's label and color are edited once, for all its profiles", async () => {
        await acmeWithProfiles();
        await ctx.projects.updateAccount({ accountId: '111122223333', label: 'Production', color: 'pink' });
        expect((await ctx.state.compute()).accounts['111122223333']).toMatchObject({ label: 'Production', color: 'pink' });
        await ctx.projects.updateAccount({ accountId: '111122223333', color: null });
        expect((await ctx.state.compute()).accounts['111122223333']).toMatchObject({ label: 'Production', color: null });
        await expect(ctx.projects.updateAccount({ accountId: '111122223333', color: 'beige' })).rejects.toThrow(/Color/);
    });

    test('a project takes its profiles and its own SSO portal with it, out of ~/.aws too when asked', async () => {
        const { projectId } = await acmeWithProfiles();
        const result = await ctx.projects.deleteProject({ id: projectId, deleteFromFiles: true });
        expect(result).toMatchObject({ profiles: 2, portals: 1 });
        const state = await ctx.state.compute();
        expect([state.projects, state.profiles, state.portals]).toEqual([[], [], []]);
        expect(t.read('config')).toBe(CONFIG);
        expect(t.read('credentials')).toBe(CREDENTIALS);
        expect(await ctx.tokens.read('acme-sso')).toBeNull();
    });

    test("a portal another project's profiles still use survives, no longer tied to the deleted project", async () => {
        const { projectId, portalId } = await acmeWithProfiles();
        const other = await seedProject(ctx, { project: 'Globex' });
        await ctx.profiles.createSso({ portalId, projectId: other.projectId, accounts: [{ accountId: '444455556666', roles: [{ roleName: 'ReadOnlyAccess', name: 'globex-dev-readonly' }] }] });
        await ctx.projects.deleteProject({ id: projectId, deleteFromFiles: true });
        const state = await ctx.state.compute();
        expect(state.portals).toHaveLength(1);
        expect(state.portals[0].projectId).toBeNull();
        expect(t.read('config')).toContain('[sso-session acme-sso]');
        expect(state.profiles.map((p) => p.name)).toEqual(['globex-dev-readonly']);
    });

    test('without deleteFromFiles, the files stay as they are and the profiles show up as unmanaged', async () => {
        const { projectId } = await acmeWithProfiles();
        const before = { config: t.read('config'), credentials: t.read('credentials') };
        await ctx.projects.deleteProject({ id: projectId });
        expect({ config: t.read('config'), credentials: t.read('credentials') }).toEqual(before);
        const state = await ctx.state.compute();
        expect(state.portals).toHaveLength(1);
        expect(state.unmanaged.map((p) => p.name)).toEqual(expect.arrayContaining(['acme-prod-deploy', 'acme-prod-admin', 'acme-prod-admin-keys']));
        expect(fs.existsSync(ctx.tokens.file('acme-sso'))).toBe(true);
    });
});
