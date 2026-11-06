'use strict';

/** A context wired to a temp directory and fake AWS clients, so tests never touch ~/.aws or the network. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../context');

function tempEnv() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-manager-test-'));
    fs.mkdirSync(path.join(dir, 'aws'), { recursive: true });
    const env = {
        AWS_CONFIG_FILE: path.join(dir, 'aws', 'config'),
        AWS_SHARED_CREDENTIALS_FILE: path.join(dir, 'aws', 'credentials'),
        PROFILE_MANAGER_HOME: path.join(dir, 'home'),
        PROFILE_MANAGER_SSO_CACHE: path.join(dir, 'aws', 'sso', 'cache'),
        PROFILE_MANAGER_ZSHRC: path.join(dir, 'zshrc'),
    };
    return {
        dir,
        env,
        write: (file, text) => fs.writeFileSync(file === 'config' ? env.AWS_CONFIG_FILE : file === 'credentials' ? env.AWS_SHARED_CREDENTIALS_FILE : file, text),
        read: (file) => fs.readFileSync(file === 'config' ? env.AWS_CONFIG_FILE : file === 'credentials' ? env.AWS_SHARED_CREDENTIALS_FILE : file, 'utf8'),
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

/** STS that knows the keys as an IAM Identity Center admin role; reading the role is denied unless `roleMaxMs` is given. */
function fakeSts(result = { ok: true, accountId: '111122223333', arn: 'arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_AdministratorAccess_0123456789abcdef/me', principal: 'AdministratorAccess' }, roleMaxMs = null) {
    return { check: jest.fn(async () => result), roleMaxSession: jest.fn(async () => roleMaxMs) };
}

function fakeSso(overrides = {}) {
    return {
        startSignIn: jest.fn(async () => ({ flowId: '00000000-0000-4000-8000-000000000001', userCode: 'ABCD-EFGH', verificationUri: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH', expiresIn: 600, interval: 1 })),
        pollSignIn: jest.fn(async () => ({ status: 'pending' })),
        refresh: jest.fn(async (token) => ({ ...token, accessToken: 'refreshed-access', expiresAt: new Date(Date.now() + 3600e3).toISOString() })),
        listAccounts: jest.fn(async () => ({ accounts: [{ accountId: '111122223333', accountName: 'Acme Prod', email: null, roles: ['AdministratorAccess', 'ReadOnlyAccess'] }] })),
        roleCredentials: jest.fn(async () => ({ credentials: { accessKeyId: 'ASIAEXPORTEDKEY00001', secretAccessKey: 'exported-secret', sessionToken: 'exported-token' }, expiresAt: new Date(Date.now() + 3600e3).toISOString() })),
        logout: jest.fn(async () => {}),
        discoverRegion: jest.fn(async () => ({ region: 'us-east-1' })),
        ...overrides,
    };
}

/** Alerts that are answered with `answer` ('ignore' by default). */
function fakeNotifier(answer = 'ignore') {
    return { prompt: jest.fn(async () => answer) };
}

const silentLog = { info: () => {}, error: () => {}, log: () => {} };

function testContext(t, options = {}) {
    return createContext({
        env: t.env,
        sts: options.sts ?? fakeSts(),
        sso: options.sso ?? fakeSso(),
        notifier: options.notifier ?? fakeNotifier(),
        now: options.now ?? (() => Date.now()),
        log: silentLog,
    });
}

/** A project; resolves to `{ projectId }`. */
async function seedProject(ctx, { project = 'Acme' } = {}) {
    const { id: projectId } = await ctx.projects.createProject({ name: project });
    return { projectId };
}

module.exports = { tempEnv, fakeSts, fakeSso, fakeNotifier, testContext, seedProject, silentLog };
