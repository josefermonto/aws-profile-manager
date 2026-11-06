'use strict';

/**
 * The snapshot the UI renders: projects, account labels, portals and managed
 * profiles with their statuses and conflicts, plus every unmanaged profile in
 * the files. Holds no secret values.
 */
const { listProfiles, describeProfile, configSection } = require('../core/awsFiles');
const { keysProfileName } = require('../core/names');
const { portalStatus, profileStatus, summarise } = require('./status');

function publicProfile(p) {
    const { fingerprints, ...rest } = p;
    return rest;
}

function createState(ctx) {
    async function compute() {
        const s = await ctx.store.get();
        const files = await ctx.files.readBoth();
        const listed = listProfiles(files);
        const nowMs = ctx.now();
        const warnMs = s.settings.warnMinutes * 60 * 1000;

        const portalStatuses = new Map();
        const portals = [];
        for (const portal of s.portals) {
            const status = portalStatus(portal, await ctx.tokens.read(portal.sessionName), nowMs, warnMs);
            portalStatuses.set(portal.id, status);
            const { session, ...rest } = portal;
            portals.push({ ...rest, status, profileCount: s.profiles.filter((p) => p.kind === 'sso' && p.sso.portalId === portal.id).length });
        }

        const byName = new Map(listed.profiles.map((p) => [p.name, p]));
        const managedNames = new Set();
        const profiles = s.profiles.map((p) => {
            managedNames.add(p.name);
            if (p.kind === 'sso' && p.sso?.exportKeys) managedNames.add(keysProfileName(p.name));
            const found = byName.get(p.name);
            const conflicts = [];
            if ((found?.config?.fingerprint ?? null) !== (p.fingerprints?.config ?? null)) conflicts.push({ file: 'config', section: configSection(p.name) });
            if (p.kind === 'keys' && (found?.credentials?.fingerprint ?? null) !== (p.fingerprints?.credentials ?? null)) {
                conflicts.push({ file: 'credentials', section: p.name });
            }
            return {
                ...publicProfile(p),
                status: profileStatus(p, { portalStatuses, nowMs, warnMs }),
                conflicts,
                missing: !found?.config && !found?.credentials,
            };
        });

        const unmanaged = listed.profiles.filter((p) => !managedNames.has(p.name)).map(describeProfile);

        return {
            now: new Date(nowMs).toISOString(),
            settings: s.settings,
            projects: s.projects,
            accounts: s.accounts,
            portals,
            profiles,
            unmanaged,
            summary: summarise(profiles.map((p) => p.status)),
            paths: { config: ctx.paths.config, credentials: ctx.paths.credentials, appHome: ctx.paths.appHome, backups: ctx.paths.backups },
            shell: await ctx.shell.status(),
            port: ctx.port,
        };
    }

    return { compute };
}

module.exports = { createState };
