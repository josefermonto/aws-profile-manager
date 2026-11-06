'use strict';

/**
 * Where everything lives. Honors the AWS CLI's own overrides
 * (AWS_CONFIG_FILE, AWS_SHARED_CREDENTIALS_FILE) so the app edits the same
 * files the CLI reads, and PROFILE_MANAGER_HOME / PROFILE_MANAGER_SSO_CACHE /
 * PROFILE_MANAGER_ZSHRC / PROFILE_MANAGER_CLAUDE_DIR so tests can point
 * everything at a temp directory.
 */
const os = require('node:os');
const path = require('node:path');

function resolvePaths(env = process.env) {
    const home = os.homedir();
    const awsDir = path.join(home, '.aws');
    const appHome = env.PROFILE_MANAGER_HOME || path.join(home, '.aws-profile-manager');
    return {
        config: env.AWS_CONFIG_FILE || path.join(awsDir, 'config'),
        credentials: env.AWS_SHARED_CREDENTIALS_FILE || path.join(awsDir, 'credentials'),
        // The SDKs and CLI always read ~/.aws/sso/cache; the override exists for tests only.
        ssoCache: env.PROFILE_MANAGER_SSO_CACHE || path.join(awsDir, 'sso', 'cache'),
        appHome,
        store: path.join(appHome, 'store.json'),
        backups: path.join(appHome, 'backups'),
        logs: path.join(appHome, 'logs'),
        shellScript: path.join(appHome, 'awspm.zsh'),
        profilesTsv: path.join(appHome, 'profiles.tsv'),
        zshrc: env.PROFILE_MANAGER_ZSHRC || path.join(home, '.zshrc'),
        // Claude Code's user folder: the skill and the guard hook go here when "Sync with Claude" is on.
        claudeDir: env.PROFILE_MANAGER_CLAUDE_DIR || path.join(home, '.claude'),
        // The command Claude Code runs (a small launcher for server/claude/cli.js).
        claudeCli: path.join(appHome, 'bin', 'awspm-claude'),
        home: env.PROFILE_MANAGER_HOME_DIR || home,
    };
}

module.exports = { resolvePaths };
