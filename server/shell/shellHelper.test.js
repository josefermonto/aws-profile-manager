'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { createShellHelper } = require('./shellHelper');
const { resolvePaths } = require('../core/paths');
const { tempEnv } = require('../test/helpers');

describe('shell helper', () => {
    let t;
    let shell;
    beforeEach(() => {
        t = tempEnv();
        shell = createShellHelper({ paths: resolvePaths(t.env), port: 5005 });
    });
    afterEach(() => t.cleanup());

    test('awspm.zsh is valid zsh', async () => {
        await shell.writeScript();
        expect(() => execFileSync('zsh', ['-n', resolvePaths(t.env).shellScript])).not.toThrow();
    });

    test('awspm use sets AWS_PROFILE for a known profile, refuses unknown ones, and tags the prompt', async () => {
        await shell.writeScript();
        await shell.writeProfiles([{ name: 'acme-prod-admin', tag: 'ACME PROD ADMIN', color: 'red' }]);
        const script = resolvePaths(t.env).shellScript;
        const out = execFileSync('zsh', ['-f', '-c', `source ${script}; awspm use acme-prod-admin; _awspm_precmd; print -r -- "$AWS_PROFILE|$_AWSPM_PROMPT"; awspm use nope 2>&1 || print refused`], {
            encoding: 'utf8', env: { PATH: process.env.PATH, HOME: t.dir },
        });
        expect(out).toContain('acme-prod-admin|%F{196}[ACME PROD ADMIN]%f ');
        expect(out).toContain("awspm: no profile named 'nope'");
        expect(out).toContain('refused');
    });

    test('install appends one source line, once, after backing up ~/.zshrc', async () => {
        t.write(t.env.PROFILE_MANAGER_ZSHRC, 'export EDITOR=vim');
        await shell.install();
        await shell.install();
        const zshrc = t.read(t.env.PROFILE_MANAGER_ZSHRC);
        expect(zshrc.match(/AWS Profile Manager/g)).toHaveLength(1);
        expect(zshrc.startsWith('export EDITOR=vim\n[ -f ')).toBe(true);
        expect(fs.readdirSync(resolvePaths(t.env).backups).some((f) => f.startsWith('zshrc.'))).toBe(true);
        expect((await shell.status()).installed).toBe(true);
    });
});
