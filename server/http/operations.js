'use strict';

/**
 * The API: `POST /api` with `{ operation, payload }`. Each operation maps to
 * one domain call; the domain validates its own input.
 */
function createOperations(ctx) {
    const { projects, profiles, portals, state, shell, notifier, claude } = ctx;
    return {
        getState: () => state.compute(),

        createProject: projects.createProject,
        updateProject: projects.updateProject,
        deleteProject: projects.deleteProject,
        updateAccount: projects.updateAccount,
        updateSettings: projects.updateSettings,

        adoptProfiles: profiles.adopt,
        pasteCredentials: profiles.paste,
        createSsoProfiles: profiles.createSso,
        updateProfile: profiles.update,
        removeProfile: profiles.remove,
        resolveConflict: profiles.resolveConflict,
        checkProfile: profiles.checkNow,

        discoverRegion: portals.discoverRegion,
        savePortal: portals.save,
        deletePortal: portals.remove,
        startSignIn: portals.startSignIn,
        pollSignIn: portals.pollSignIn,
        signOut: portals.signOut,
        listAccounts: portals.listAccounts,

        installShell: () => shell.install(),

        // Claude Code: the toggle, and what its skill and hook ask (server/claude).
        setClaudeSync: claude.setSync,
        claudeContext: claude.context,
        claudeHook: claude.hook,
        claudeLink: claude.link,
        /** Shows a test alert. Waits a moment for a failure, not for the answer. */
        testNotification: async () => {
            const answer = notifier.prompt({
                message: 'Alerts work. One like this appears when a sign-in is about to end or has ended, and when pasted keys expire.',
                action: 'Open AWS Profile Manager',
                url: `http://localhost:${ctx.port}/`,
                key: 'test',
            });
            const early = await Promise.race([answer, new Promise((resolve) => setTimeout(() => resolve('showing'), 1500))]);
            return { shown: early !== 'failed' && early !== 'unsupported', unsupported: early === 'unsupported' };
        },
    };
}

module.exports = { createOperations };
