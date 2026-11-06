'use strict';

/**
 * Projects, account labels, and app settings. These live only in the store.
 * Deleting a project also deletes its profiles, and with `deleteFromFiles`
 * removes them from ~/.aws as well (each file is backed up first).
 */
const { ValidationError } = require('../core/errors');
const { sessionSection } = require('../core/awsFiles');
const { newId } = require('../core/names');
const { removalEdits } = require('./profiles');
const { ENV_COLORS } = require('./colors');
const v = require('../core/validate');

function createProjects({ store, files, tokens }) {
    const find = (list, id, what) => {
        const item = list.find((x) => x.id === id);
        if (!item) throw new ValidationError(`That ${what} no longer exists.`);
        return item;
    };

    function createProject(payload) {
        const name = v.text(payload?.name, 'Project name', { max: 60 });
        return store.update((s) => {
            if (s.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new ValidationError(`There's already a project called ${name}.`);
            const project = { id: newId(), name, folders: [] };
            s.projects.push(project);
            return { id: project.id };
        });
    }

    /** Renames a project and/or sets its linked folders (where its repos live, for Claude). */
    async function updateProject(payload) {
        const id = v.id(payload?.id, 'Project');
        const name = payload?.name !== undefined ? v.text(payload.name, 'Project name', { max: 60 }) : undefined;
        const folders = payload?.folders !== undefined ? v.array(payload.folders, 'Folders', { max: 20, min: 0 }).map(folderPattern) : undefined;
        return store.update((s) => {
            const project = find(s.projects, id, 'project');
            if (name !== undefined) project.name = name;
            if (folders !== undefined) {
                const unique = [...new Set(folders)];
                // A folder belongs to one project.
                for (const p of s.projects) if (p !== project) p.folders = (p.folders ?? []).filter((f) => !unique.includes(f));
                project.folders = unique;
            }
            return { id };
        });
    }

    /**
     * Deletes the project with its profiles. With `deleteFromFiles` they leave
     * ~/.aws too, and the project's SSO portals go when no other profile uses
     * them; otherwise the portals stay, no longer tied to a project.
     */
    function deleteProject(payload) {
        const id = v.id(payload?.id, 'Project');
        const deleteFromFiles = payload?.deleteFromFiles === true;
        return store.update(async (s) => {
            find(s.projects, id, 'project');
            const profiles = s.profiles.filter((p) => p.projectId === id);
            if (deleteFromFiles && profiles.length) await files.apply(profiles.flatMap(removalEdits));
            s.profiles = s.profiles.filter((p) => p.projectId !== id);
            const removedPortals = [];
            for (const portal of s.portals.filter((p) => p.projectId === id)) {
                const stillUsed = s.profiles.some((p) => p.kind === 'sso' && p.sso.portalId === portal.id);
                if (deleteFromFiles && !stillUsed) removedPortals.push(portal);
                else portal.projectId = null;
            }
            if (removedPortals.length) {
                for (const portal of removedPortals) await tokens.remove(portal.sessionName);
                await files.apply(removedPortals.map((p) => ({ file: 'config', section: sessionSection(p.sessionName), remove: true })));
                s.portals = s.portals.filter((p) => !removedPortals.includes(p));
            }
            s.projects = s.projects.filter((p) => p.id !== id);
            return { id, profiles: profiles.length, portals: removedPortals.length };
        });
    }

    /** An AWS account's label and color, shared by all its profiles. */
    function updateAccount(payload) {
        const accountId = v.text(payload?.accountId, 'Account ID', { re: v.ACCOUNT_ID_RE, reMessage: 'Account IDs are 12 digits.' });
        return store.update((s) => {
            const current = s.accounts[accountId] ?? { name: null, label: '', color: null };
            s.accounts[accountId] = {
                ...current,
                ...(payload.label !== undefined ? { label: v.text(payload.label, 'Label', { max: 30, optional: true }) ?? '' } : {}),
                ...(payload.color !== undefined ? { color: payload.color === null ? null : v.oneOf(payload.color, 'Color', ENV_COLORS) } : {}),
            };
            return { accountId };
        });
    }

    function updateSettings(payload) {
        return store.update((s) => {
            if (payload?.warnMinutes !== undefined) s.settings.warnMinutes = v.int(payload.warnMinutes, 'Warning time', { min: 1, max: 240 });
            if (payload?.notifications !== undefined) s.settings.notifications = payload.notifications === true;
            return { settings: s.settings };
        });
    }

    return { createProject, updateProject, deleteProject, updateAccount, updateSettings };
}

/** A linked folder: `~/…` or an absolute path; `*` matches within one folder name. */
function folderPattern(value) {
    const text = v.text(value, 'Folder', { max: 300 }).replace(/(.)\/+$/, '$1');
    if (!/^(~\/|\/)/.test(text) || /[\0\n\r]/.test(text)) throw new ValidationError(`${text}: use a full path, like ~/repos/acme-api or ~/repos/acme-*.`);
    if (text === '/' || text === '~/' || /^~?\/\*?$/.test(text)) throw new ValidationError(`${text} is too broad: link the folders that hold this project's repos.`);
    return text;
}

module.exports = { createProjects, ENV_COLORS };
