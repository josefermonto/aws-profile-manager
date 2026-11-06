'use strict';

/**
 * Wires the pieces together. Everything takes its dependencies from here, so
 * tests build the same context with temp paths and fake AWS clients.
 */
const { resolvePaths } = require('./core/paths');
const { createStore } = require('./core/store');
const { createAwsFiles } = require('./core/awsFiles');
const { createTokenCache } = require('./sso/tokenCache');
const { createSsoService } = require('./sso/ssoService');
const { createSts } = require('./creds/sts');
const { createProjects } = require('./domain/projects');
const { createProfiles } = require('./domain/profiles');
const { createPortals } = require('./domain/portals');
const { createState } = require('./domain/state');
const { createWatcher } = require('./watcher/watcher');
const { createNotifier } = require('./watcher/notifier');
const { createShellHelper } = require('./shell/shellHelper');
const { createClaude } = require('./claude/claude');

function createContext({
    env = process.env,
    port = 5005,
    now = () => Date.now(),
    sso = createSsoService(),
    sts = createSts(),
    notifier = createNotifier(),
    log = console,
    watcherInterval,
} = {}) {
    const paths = resolvePaths(env);
    const ctx = { paths, port, now, sso, sts, notifier, log };
    ctx.store = createStore({ file: paths.store });
    ctx.files = createAwsFiles({ paths, now: () => new Date(now()) });
    ctx.tokens = createTokenCache({ dir: paths.ssoCache });
    ctx.shell = createShellHelper({ paths, port, now: () => new Date(now()) });
    ctx.projects = createProjects(ctx);
    ctx.profiles = createProfiles(ctx);
    ctx.portals = createPortals(ctx);
    ctx.state = createState(ctx);
    ctx.claude = createClaude(ctx);
    ctx.watcher = createWatcher(ctx, { intervalMs: watcherInterval, log });
    return ctx;
}

module.exports = { createContext };
