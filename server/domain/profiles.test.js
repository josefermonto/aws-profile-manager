'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { tempEnv, testContext, seedProject, fakeSts } = require('../test/helpers');
const { ConflictError, ValidationError } = require('../core/errors');

const CONFIG = `[default]
region = us-east-1

[legacy-dev]
region = eu-west-1
cli_pager =
`;
const CREDENTIALS = `[default]
aws_access_key_id = AKIADEFAULTDEFAULT00
aws_secret_access_key = default-secret

[legacy-dev]
aws_access_key_id = ASIALEGACYLEGACY0000
aws_secret_access_key = legacy-secret
aws_session_token = legacy-token
`;
const PASTE = `[111122223333_PowerUserAccess]
aws_access_key_id=ASIAPASTEDPASTED0000
aws_secret_access_key=pasted-secret
aws_session_token=pasted-token`;
const SECRETS = ['default-secret', 'legacy-secret', 'legacy-token', 'pasted-secret', 'pasted-token', 'exported-secret', 'exported-token'];

describe('profiles', () => {
    let t;
    let ctx;
    let ids;
    beforeEach(async () => {
        t = tempEnv();
        t.write('config', CONFIG);
        t.write('credentials', CREDENTIALS);
        ctx = testContext(t);
        ids = await seedProject(ctx);
    });
    afterEach(() => t.cleanup());

    const expectNoSecrets = async () => {
        const state = JSON.stringify(await ctx.state.compute());
        const store = fs.readFileSync(ctx.paths.store, 'utf8');
        for (const secret of SECRETS) {
            expect(state).not.toContain(secret);
            expect(store).not.toContain(secret);
        }
    };

    test('adopting fixes a bare config section and leaves everything else as it was', async () => {
        await ctx.profiles.adopt({ items: [{ name: 'legacy-dev', projectId: ids.projectId }] });
        expect(t.read('config')).toBe(CONFIG.replace('[legacy-dev]', '[profile legacy-dev]'));
        expect(t.read('credentials')).toBe(CREDENTIALS);

        const state = await ctx.state.compute();
        const adopted = state.profiles.find((p) => p.name === 'legacy-dev');
        expect(adopted).toMatchObject({ kind: 'keys', region: 'eu-west-1', conflicts: [], keys: { temporary: true } });
        expect(state.unmanaged.map((p) => p.name)).toEqual(['default']);
        await expectNoSecrets();
    });

    test('pasting creates a profile, checked with STS, and the keys only land in ~/.aws/credentials', async () => {
        const result = await ctx.profiles.paste({ projectId: ids.projectId, name: 'acme-prod-poweruser', blob: PASTE });
        expect(result.accountId).toBe('111122223333');
        expect(t.read('credentials')).toContain('[acme-prod-poweruser]\naws_access_key_id = ASIAPASTEDPASTED0000\naws_secret_access_key = pasted-secret\naws_session_token = pasted-token\n');
        expect(t.read('config')).toContain('[profile acme-prod-poweruser]\nregion = us-east-1\noutput = json\n');
        const profile = (await ctx.state.compute()).profiles.find((p) => p.id === result.id);
        expect(profile).toMatchObject({ label: 'AdministratorAccess', status: { state: 'active', estimated: true } });
        await expectNoSecrets();
    });

    test("pasted keys get their expiry from the role's session length when it can be read", async () => {
        const c = testContext(t, { sts: fakeSts(undefined, 4 * 3600e3) });
        const { projectId } = await seedProject(c, { project: 'Other' });
        const before = Date.now();
        const r = await c.profiles.paste({ projectId, name: 'other-prod-admin', blob: PASTE });
        expect(r.expiryBasis).toBe('role');
        expect(Date.parse(r.expiresAt) - before).toBeGreaterThanOrEqual(4 * 3600e3 - 1000);
        expect(c.sts.roleMaxSession).toHaveBeenCalledWith(expect.objectContaining({ accessKeyId: 'ASIAPASTEDPASTED0000' }), 'AWSReservedSSO_AdministratorAccess_0123456789abcdef');
        const profile = (await c.state.compute()).profiles.find((p) => p.id === r.id);
        expect(profile.status.note).toMatch(/sessions last 4 h \(read from the role\)/);
    });

    test('without the role, the 1 h default; once they expire, the real length is learned for the next paste', async () => {
        let now = Date.now();
        const c = testContext(t, { now: () => now });
        const { projectId } = await seedProject(c, { project: 'Other' });
        const first = await c.profiles.paste({ projectId, name: 'other-prod-admin', blob: PASTE });
        expect(first).toMatchObject({ expiryBasis: 'default', lifetimeMs: 3600e3 });

        // These keys actually last 2 h: STS still says yes at 1 h, and says expired just after 2 h.
        now += 2 * 3600e3 + 2 * 60e3;
        c.sts.check.mockResolvedValueOnce({ ok: false, code: 'expired', message: 'These credentials have expired.' });
        await c.profiles.probe(first.id);
        expect((await c.store.get()).learnedKeyLifetimes).toEqual({ '111122223333:AWSReservedSSO_AdministratorAccess_0123456789abcdef': 2 * 3600e3 });

        const second = await c.profiles.paste({ profileId: first.id, blob: PASTE });
        expect(second).toMatchObject({ expiryBasis: 'learned', lifetimeMs: 2 * 3600e3 });
    });

    test('long-lived keys have no expiry to detect', async () => {
        const r = await ctx.profiles.paste({ projectId: ids.projectId, name: 'acme-prod-ci', blob: 'aws_access_key_id=AKIAPASTEDPASTED0000\naws_secret_access_key=s' });
        expect(r).toMatchObject({ expiresAt: null, expiryBasis: null });
        expect(ctx.sts.roleMaxSession).not.toHaveBeenCalled();
    });

    test('expired or invalid keys are refused before anything is written', async () => {
        const c = testContext(t, { sts: fakeSts({ ok: false, code: 'expired', message: 'These credentials have expired.' }) });
        const { projectId } = await seedProject(c, { project: 'Other' });
        await expect(c.profiles.paste({ projectId, name: 'x-prod-admin', blob: PASTE })).rejects.toThrow('expired');
        expect(t.read('credentials')).toBe(CREDENTIALS);
    });

    test('a new name may not clash with a profile already in the files', async () => {
        await expect(ctx.profiles.paste({ projectId: ids.projectId, name: 'legacy-dev', blob: PASTE })).rejects.toThrow(/already in your AWS files/);
        await expect(ctx.profiles.paste({ projectId: ids.projectId, name: 'bad name', blob: PASTE })).rejects.toBeInstanceOf(ValidationError);
    });

    test('re-pasting replaces the keys in place', async () => {
        const { id } = await ctx.profiles.paste({ projectId: ids.projectId, name: 'acme-prod-poweruser', blob: PASTE });
        await ctx.profiles.paste({ profileId: id, blob: PASTE.replace(/pasted-/g, 'fresh-') });
        const creds = t.read('credentials');
        expect(creds).toContain('aws_secret_access_key = fresh-secret');
        expect(creds).not.toContain('pasted-secret');
        expect((await ctx.state.compute()).profiles.find((p) => p.id === id).conflicts).toEqual([]);
    });

    test('an outside edit to a managed section is reported, refused, then resolved', async () => {
        const { id } = await ctx.profiles.paste({ projectId: ids.projectId, name: 'acme-prod-poweruser', blob: PASTE });
        t.write('config', t.read('config').replace('[profile acme-prod-poweruser]\nregion = us-east-1', '[profile acme-prod-poweruser]\nregion = ap-south-1'));
        expect((await ctx.state.compute()).profiles.find((p) => p.id === id).conflicts).toEqual([{ file: 'config', section: 'profile acme-prod-poweruser' }]);
        await expect(ctx.profiles.update({ id, region: 'us-west-2' })).rejects.toBeInstanceOf(ConflictError);

        await ctx.profiles.resolveConflict({ id, action: 'accept' });
        const resolved = (await ctx.state.compute()).profiles.find((p) => p.id === id);
        expect(resolved).toMatchObject({ region: 'ap-south-1', conflicts: [] });
        await ctx.profiles.update({ id, region: 'us-west-2' });
        expect(t.read('config')).toContain('[profile acme-prod-poweruser]\nregion = us-west-2');
    });

    test('SSO profiles are written as native sso-session profiles', async () => {
        const { id: portalId } = await ctx.portals.save({ name: 'Acme', startUrl: 'https://acme.awsapps.com/start/#/', region: 'us-east-1' });
        await ctx.profiles.createSso({
            portalId, projectId: ids.projectId,
            accounts: [{ accountId: '111122223333', accountName: 'Acme Prod', label: 'Prod', color: 'red', roles: [{ roleName: 'AdministratorAccess', name: 'acme-prod-admin' }] }],
        });
        const config = t.read('config');
        expect(config).toContain('[sso-session acme]\nsso_start_url = https://acme.awsapps.com/start\nsso_region = us-east-1\nsso_registration_scopes = sso:account:access\n');
        expect(config).toContain('[profile acme-prod-admin]\nsso_session = acme\nsso_account_id = 111122223333\nsso_role_name = AdministratorAccess\nregion = us-east-1\noutput = json\n');
        const state = await ctx.state.compute();
        const profile = state.profiles.find((p) => p.name === 'acme-prod-admin');
        expect(profile).toMatchObject({ kind: 'sso', label: 'AdministratorAccess', accountId: '111122223333', status: { state: 'signed-out' }, conflicts: [] });
        expect(state.accounts['111122223333']).toEqual({ name: 'Acme Prod', label: 'Prod', color: 'red' });
    });

    test('"also write plain keys" writes a <name>-keys sibling, and turning it off removes it', async () => {
        const { id: portalId } = await ctx.portals.save({ name: 'Acme', startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
        await ctx.tokens.write('acme', { startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1', accessToken: 'tok', expiresAt: new Date(Date.now() + 3600e3).toISOString(), refreshToken: 'r', clientId: 'c', clientSecret: 's' });
        const { ids: [id] } = await ctx.profiles.createSso({
            portalId, projectId: ids.projectId, exportKeys: true,
            accounts: [{ accountId: '111122223333', roles: [{ roleName: 'AdministratorAccess', name: 'acme-prod-admin' }] }],
        });
        await ctx.profiles.writeExportedKeys(id);
        expect(t.read('credentials')).toContain('[acme-prod-admin-keys]\naws_access_key_id = ASIAEXPORTEDKEY00001\n');
        expect(t.read('config')).toContain('[profile acme-prod-admin-keys]\nregion = us-east-1\n');
        expect((await ctx.state.compute()).unmanaged.map((p) => p.name)).not.toContain('acme-prod-admin-keys');
        await expectNoSecrets();

        await ctx.profiles.update({ id, exportKeys: false });
        expect(t.read('credentials')).not.toContain('acme-prod-admin-keys');
        expect(t.read('config')).not.toContain('acme-prod-admin-keys');
    });

    test('removing with deleteFromFiles removes its sections; without it, the files stay', async () => {
        const { id } = await ctx.profiles.paste({ projectId: ids.projectId, name: 'acme-prod-poweruser', blob: PASTE });
        await ctx.profiles.remove({ id, deleteFromFiles: false });
        expect(t.read('credentials')).toContain('acme-prod-poweruser');

        const again = await ctx.profiles.adopt({ items: [{ name: 'acme-prod-poweruser', projectId: ids.projectId }] });
        await ctx.profiles.remove({ id: again.ids[0], deleteFromFiles: true });
        expect(t.read('credentials')).toBe(CREDENTIALS);
        expect(t.read('config')).toBe(CONFIG);
        expect(fs.readdirSync(path.join(t.env.PROFILE_MANAGER_HOME, 'backups')).length).toBeGreaterThan(0);
    });

    test('probing records the STS result without touching the files', async () => {
        await ctx.profiles.adopt({ items: [{ name: 'legacy-dev', projectId: ids.projectId }] });
        const id = (await ctx.store.get()).profiles[0].id;
        await ctx.profiles.probe(id);
        expect(ctx.sts.check).toHaveBeenCalledWith({ accessKeyId: 'ASIALEGACYLEGACY0000', secretAccessKey: 'legacy-secret', sessionToken: 'legacy-token' });
        const profile = (await ctx.state.compute()).profiles[0];
        expect(profile).toMatchObject({ accountId: '111122223333', status: { state: 'active' } });
    });
});
