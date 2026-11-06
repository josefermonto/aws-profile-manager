'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createAwsFiles, listProfiles, describeProfile } = require('./awsFiles');
const { resolvePaths } = require('./paths');
const { ConflictError } = require('./errors');
const { tempEnv } = require('../test/helpers');

const CONFIG = `[default]
region = us-east-1

[acme-dev]
region = eu-west-1

[sso-session acme]
sso_start_url = https://acme.awsapps.com/start
sso_region = us-east-1

[profile acme-prod]
sso_session = acme
sso_account_id = 111122223333
sso_role_name = AdministratorAccess
`;
const CREDENTIALS = `[default]
aws_access_key_id = AKIAAAAAAAAAAAAAAAAA
aws_secret_access_key = default-secret

[acme-dev]
aws_access_key_id = ASIABBBBBBBBBBBBBBBB
aws_secret_access_key = dev-secret
aws_session_token = dev-token
`;

describe('awsFiles', () => {
    let t;
    let files;
    beforeEach(() => {
        t = tempEnv();
        t.write('config', CONFIG);
        t.write('credentials', CREDENTIALS);
        files = createAwsFiles({ paths: resolvePaths(t.env) });
    });
    afterEach(() => t.cleanup());

    test('lists every profile across both files', async () => {
        const { profiles, sessions } = listProfiles(await files.readBoth());
        expect(profiles.map((p) => p.name).sort()).toEqual(['acme-dev', 'acme-prod', 'default']);
        expect(Object.keys(sessions)).toEqual(['acme']);
        const dev = profiles.find((p) => p.name === 'acme-dev');
        expect(dev.config).toBeNull();
        expect(dev.bareConfig.values.region).toBe('eu-west-1');
    });

    test('describes profiles without secrets, and flags bare config sections', async () => {
        const described = listProfiles(await files.readBoth()).profiles.map(describeProfile);
        const text = JSON.stringify(described);
        for (const secret of ['default-secret', 'dev-secret', 'dev-token', 'AKIAAAAAAAAAAAAAAAAA']) expect(text).not.toContain(secret);
        const dev = described.find((p) => p.name === 'acme-dev');
        expect(dev).toMatchObject({ kind: 'keys', temporary: true, keyId: 'ASIA…BBBB', region: 'eu-west-1' });
        expect(dev.warnings[0]).toMatch(/ignores its region/);
        expect(described.find((p) => p.name === 'acme-prod')).toMatchObject({ kind: 'sso', ssoSession: 'acme', accountId: '111122223333' });
        expect(described.find((p) => p.name === 'default').warnings).toEqual([]);
    });

    test('edits only the sections it is told to, backs up, and keeps mode 600', async () => {
        await files.apply([{ file: 'config', section: 'profile acme-dev', replaces: 'acme-dev', patch: {} }]);
        const config = t.read('config');
        expect(config).toBe(CONFIG.replace('[acme-dev]', '[profile acme-dev]'));
        expect(t.read('credentials')).toBe(CREDENTIALS);
        expect(fs.statSync(t.env.AWS_CONFIG_FILE).mode & 0o777).toBe(0o600);
        const backups = fs.readdirSync(path.join(t.env.PROFILE_MANAGER_HOME, 'backups'));
        expect(backups).toHaveLength(1);
        expect(fs.readFileSync(path.join(t.env.PROFILE_MANAGER_HOME, 'backups', backups[0]), 'utf8')).toBe(CONFIG);
    });

    test('refuses to overwrite a section that changed outside the app, unless forced', async () => {
        const fp = await files.apply([{ file: 'config', section: 'profile x', patch: { region: 'us-east-1' }, expect: null }]);
        t.write('config', t.read('config').replace('[profile x]\nregion = us-east-1', '[profile x]\nregion = ap-south-1'));
        const edit = { file: 'config', section: 'profile x', patch: { region: 'us-west-2' }, expect: fp['config:profile x'] };
        await expect(files.apply([edit])).rejects.toBeInstanceOf(ConflictError);
        expect(t.read('config')).toContain('ap-south-1');
        await files.apply([edit], { force: true });
        expect(t.read('config')).toContain('[profile x]\nregion = us-west-2');
    });

    test('expect: null refuses to create over an existing section', async () => {
        await expect(files.apply([{ file: 'config', section: 'profile acme-prod', patch: { region: 'x' }, expect: null }])).rejects.toBeInstanceOf(ConflictError);
    });

    test('creates the files when they do not exist yet', async () => {
        fs.rmSync(t.env.AWS_CONFIG_FILE);
        await files.apply([{ file: 'config', section: 'profile new', patch: { region: 'us-east-1', output: 'json' } }]);
        expect(t.read('config')).toBe('[profile new]\nregion = us-east-1\noutput = json\n');
    });
});
