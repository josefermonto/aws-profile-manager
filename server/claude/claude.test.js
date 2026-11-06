'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { tempEnv, testContext, seedProject } = require('../test/helpers');
const { createHttpServer } = require('../http/server');
const { createOperations } = require('../http/operations');
const { folderRegex, projectForFolder, MARKER } = require('./claude');

const ACCOUNTS = [
    { accountId: '111122223333', accountName: 'Acme Dev', label: 'Dev', color: 'green', roles: [{ roleName: 'AdministratorAccess', name: 'acme-dev-admin' }] },
    { accountId: '444455556666', accountName: 'Acme Prod', label: 'Prod', color: 'red', roles: [{ roleName: 'AdministratorAccess', name: 'acme-prod-admin' }] },
];

/** A project with two SSO profiles (Dev, Prod), signed in, and its repos linked. */
async function seed(ctx, t) {
    const { projectId } = await seedProject(ctx);
    const { id: portalId } = await ctx.portals.save({ projectId, startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1' });
    await ctx.profiles.createSso({ portalId, projectId, region: 'us-east-1', accounts: ACCOUNTS });
    await ctx.tokens.write('acme-sso', { startUrl: 'https://acme.awsapps.com/start', region: 'us-east-1', accessToken: 'a', refreshToken: 'r', clientId: 'c', clientSecret: 's', expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    await ctx.projects.updateProject({ id: projectId, folders: ['~/repos/acme-*'] });
    const home = t.env.PROFILE_MANAGER_HOME_DIR;
    return { projectId, portalId, repo: path.join(home, 'repos', 'acme-api', 'src') };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('linked folders', () => {
    test('`*` matches within one folder name; the folder and everything under it', () => {
        const re = folderRegex('~/repos/acme-*', '/Users/me');
        expect(re.test('/Users/me/repos/acme-api')).toBe(true);
        expect(re.test('/Users/me/repos/acme-api/src/x')).toBe(true);
        expect(re.test('/Users/me/repos/globex-api')).toBe(false);
        expect(re.test('/Users/me/repos/acme-api-old/x')).toBe(true);
        expect(re.test('/Users/me/repos2/acme-api')).toBe(false);
    });

    test('the most specific link wins', () => {
        const projects = [{ id: 'a', folders: ['~/repos'] }, { id: 'b', folders: ['~/repos/b-*'] }];
        expect(projectForFolder(projects, '/Users/me/repos/b-api', '/Users/me').project.id).toBe('b');
        expect(projectForFolder(projects, '/Users/me/repos/c-api', '/Users/me').project.id).toBe('a');
        expect(projectForFolder(projects, '/tmp/x', '/Users/me')).toBeNull();
    });

    test('a folder belongs to one project; too-broad links are refused', async () => {
        const t = tempEnv();
        try {
            const ctx = testContext(t);
            const { projectId: a } = await seedProject(ctx, { project: 'Acme' });
            const { projectId: b } = await seedProject(ctx, { project: 'Globex' });
            await ctx.projects.updateProject({ id: a, folders: ['~/repos/shared/'] });
            await ctx.projects.updateProject({ id: b, folders: ['~/repos/shared'] });
            const s = await ctx.store.get();
            expect(s.projects.map((p) => p.folders)).toEqual([[], ['~/repos/shared']]);
            await expect(ctx.projects.updateProject({ id: a, folders: ['~'] })).rejects.toThrow(/full path/);
            await expect(ctx.projects.updateProject({ id: a, folders: ['~/*'] })).rejects.toThrow(/too broad/);
            await expect(ctx.projects.updateProject({ id: a, folders: ['repos/x'] })).rejects.toThrow(/full path/);
        } finally {
            t.cleanup();
        }
    });
});

describe('Claude sync', () => {
    let t;
    afterEach(() => t.cleanup());

    test("on: writes the skill, the launcher, and its own entries in settings.json, keeping everything else; off: removes exactly those", async () => {
        t = tempEnv();
        const ctx = testContext(t);
        const settingsFile = path.join(t.env.PROFILE_MANAGER_CLAUDE_DIR, 'settings.json');
        const mine = { model: 'opus', permissions: { allow: ['Bash(npm test *)'] }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-lint' }] }] } };
        fs.mkdirSync(t.env.PROFILE_MANAGER_CLAUDE_DIR, { recursive: true });
        fs.writeFileSync(settingsFile, JSON.stringify(mine));

        const on = await ctx.claude.setSync({ on: true });
        expect(on).toMatchObject({ sync: true, skill: true, hook: true });
        const cli = ctx.paths.claudeCli;
        expect(readJson(settingsFile)).toEqual({
            model: 'opus',
            permissions: { allow: ['Bash(npm test *)', `Bash(${cli} context *)`] },
            hooks: { PreToolUse: [mine.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [{ type: 'command', command: `${cli} hook`, timeout: 10 }] }] },
        });
        const skill = fs.readFileSync(path.join(t.env.PROFILE_MANAGER_CLAUDE_DIR, 'skills', 'aws-profiles', 'SKILL.md'), 'utf8');
        expect(skill).toMatch(/^---\nname: aws-profiles\ndescription: /);
        expect(skill).toContain(`${cli} context`);
        expect(fs.statSync(cli).mode & 0o111).toBeTruthy();
        expect(fs.readdirSync(ctx.paths.backups).filter((f) => f.startsWith('claude-settings.'))).toHaveLength(1);

        await ctx.claude.setSync({ on: true }); // again: no duplicates
        expect(readJson(settingsFile).hooks.PreToolUse).toHaveLength(2);

        const off = await ctx.claude.setSync({ on: false });
        expect(off).toMatchObject({ sync: false, skill: false, hook: false });
        expect(readJson(settingsFile)).toEqual(mine);
        expect(fs.existsSync(path.join(t.env.PROFILE_MANAGER_CLAUDE_DIR, 'skills', 'aws-profiles'))).toBe(false);
        expect(fs.existsSync(cli)).toBe(false);
    });

    test("leaves a broken settings.json, and someone else's aws-profiles skill, alone", async () => {
        t = tempEnv();
        const ctx = testContext(t);
        const dir = t.env.PROFILE_MANAGER_CLAUDE_DIR;
        fs.mkdirSync(path.join(dir, 'skills', 'aws-profiles'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'skills', 'aws-profiles', 'SKILL.md'), '---\nname: aws-profiles\n---\nmine');
        await expect(ctx.claude.setSync({ on: true })).rejects.toThrow(/didn't write/);
        fs.rmSync(path.join(dir, 'skills'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'settings.json'), '{ "model": ');
        await expect(ctx.claude.setSync({ on: true })).rejects.toThrow(/isn't valid JSON/);
        expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe('{ "model": ');
        expect((await ctx.store.get()).settings.claudeSync).toBe(false);
    });

    test("context: the linked project's profiles with live status; other folders get project names only", async () => {
        t = tempEnv();
        const ctx = testContext(t);
        const { repo } = await seed(ctx, t);
        const { text } = await ctx.claude.context({ cwd: repo });
        expect(text).toMatch(/^Project Acme \(this folder matches ~\/repos\/acme-\*\)/);
        expect(text).toMatch(/acme-dev-admin\s+Dev\s+111122223333 Acme Dev\s+AdministratorAccess\s+us-east-1\s+Active, ~(8h|7h 59m) left/);
        expect(text).toMatch(/acme-prod-admin\s+Prod/);
        expect(text).not.toMatch(/secret|"a"/);

        const other = await ctx.claude.context({ cwd: path.join(t.env.PROFILE_MANAGER_HOME_DIR, 'repos', 'globex-api') });
        expect(other.text).toContain("isn't linked to a project");
        expect(other.text).toContain('Projects: Acme.');
        expect(other.text).not.toContain('acme-dev-admin');

        expect((await ctx.claude.link({ project: 'acme', folder: path.join(t.env.PROFILE_MANAGER_HOME_DIR, 'work', 'acme-tools') })).text).toMatch(/Linked ~\/work\/acme-tools to Acme/);
        await expect(ctx.claude.link({ project: 'Nope', folder: '/tmp/x' })).rejects.toThrow(/no project called "Nope"\. Projects: Acme/);
    });

    test('the hook sees live state, and only while sync is on', async () => {
        t = tempEnv();
        const ctx = testContext(t);
        const { repo } = await seed(ctx, t);
        const command = 'aws s3 rm s3://bucket/key --profile acme-prod-admin';
        expect(await ctx.claude.hook({ cwd: repo, command })).toEqual({ decision: null, reason: null });
        await ctx.claude.setSync({ on: true });
        expect(await ctx.claude.hook({ cwd: repo, command })).toMatchObject({ decision: 'ask', reason: expect.stringContaining('Prod account (444455556666 Acme Prod)') });
        await ctx.tokens.remove('acme-sso'); // signed out
        expect(await ctx.claude.hook({ cwd: repo, command: 'aws s3 ls --profile acme-dev-admin' })).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/sign in again: http:\/\/localhost:5005\/#sign-in=/) });
    });

    test('end to end: Claude Code runs the CLI with its JSON on stdin and reads the decision', async () => {
        t = tempEnv();
        const ctx = testContext(t);
        const { repo } = await seed(ctx, t);
        await ctx.claude.setSync({ on: true });
        const server = createHttpServer({ operations: createOperations(ctx), port: 0, log: { info() {}, error() {} } });
        // The request guard checks the Host header against the port, so listen first and use the real one.
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        server.close();
        const real = createHttpServer({ operations: createOperations(ctx), port, log: { info() {}, error() {} } });
        await new Promise((resolve) => real.listen(port, '127.0.0.1', resolve));
        const run = (args, stdin) => new Promise((resolve) => {
            const child = execFile(process.execPath, [path.join(__dirname, 'cli.js'), ...args], { env: { ...process.env, PROFILE_MANAGER_PORT: String(port) }, cwd: __dirname }, (error, stdout) => resolve(stdout));
            if (stdin !== undefined) child.stdin.end(stdin);
        });
        try {
            const hookInput = (command) => JSON.stringify({ session_id: 's', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
            const asked = JSON.parse(await run(['hook'], hookInput('AWS_PROFILE=acme-prod-admin cdk deploy')));
            expect(asked).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: expect.stringMatching(/^AWS Profile Manager: acme-prod-admin is in a Prod account/) } });
            expect(await run(['hook'], hookInput('aws s3 ls --profile acme-dev-admin'))).toBe('');
            expect(await run(['hook'], hookInput('git status'))).toBe('');
            expect(await run(['context'])).toContain("isn't linked to a project");
        } finally {
            real.close();
        }
        // With the service down, the stateless checks still hold, and nothing else is blocked.
        const denied = JSON.parse(await run(['hook'], JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'cat ~/.aws/credentials' } })));
        expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(await run(['hook'], JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'aws s3 rm s3://b/k --profile acme-prod-admin' } }))).toBe('');
        expect(await run(['context'])).toMatch(/isn't answering/);
    });

    test('ensure() rewrites its own files at start when sync is on, and never settings.json', async () => {
        t = tempEnv();
        const ctx = testContext(t);
        await ctx.claude.setSync({ on: true });
        const settingsFile = path.join(t.env.PROFILE_MANAGER_CLAUDE_DIR, 'settings.json');
        fs.writeFileSync(settingsFile, '{}');
        fs.rmSync(ctx.paths.claudeCli);
        await ctx.claude.ensure();
        expect(fs.readFileSync(ctx.paths.claudeCli, 'utf8')).toContain(MARKER);
        expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{}');
        expect(await ctx.claude.status()).toMatchObject({ sync: true, skill: true, hook: false });
    });
});
