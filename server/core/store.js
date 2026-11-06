'use strict';

/**
 * The app's own data: projects, account labels, portals, profile metadata and
 * settings, in ~/.aws-profile-manager/store.json (mode 600).
 *
 * It never holds a secret. Keys live in ~/.aws/credentials and sign-in tokens
 * in ~/.aws/sso/cache, where the AWS tools read them; this file only knows
 * which sections the app manages and what they looked like when written.
 */
const { readText, writeAtomic, createLock } = require('./fsx');

const STORE_VERSION = 2;

function emptyStore() {
    return {
        version: STORE_VERSION,
        settings: { warnMinutes: 15, notifications: true },
        learnedKeyLifetimes: {},
        projects: [],
        // accountId → { name, label, color }: shared by every profile in that AWS account.
        accounts: {},
        portals: [],
        profiles: [],
    };
}

function normalise(data) {
    const base = emptyStore();
    return {
        ...base,
        ...data,
        settings: { ...base.settings, ...(data?.settings ?? {}) },
        // How long pasted keys lasted, per account and role, learned when they expired (creds/expiry.js).
        learnedKeyLifetimes: data?.learnedKeyLifetimes ?? {},
        projects: data?.projects ?? [],
        accounts: data?.accounts ?? {},
        portals: data?.portals ?? [],
        profiles: data?.profiles ?? [],
    };
}

function createStore({ file }) {
    const lock = createLock();
    let cache = null;

    async function load() {
        if (!cache) {
            const text = await readText(file);
            cache = text ? normalise(JSON.parse(text)) : emptyStore();
        }
        return cache;
    }

    /** A snapshot: safe to read while other updates run. */
    async function get() {
        return structuredClone(await load());
    }

    /**
     * Runs `fn` on a draft and saves it when `fn` succeeds; updates run one at
     * a time. A throw leaves the store as it was.
     */
    function update(fn) {
        return lock(async () => {
            const draft = structuredClone(await load());
            const result = await fn(draft);
            await writeAtomic(file, `${JSON.stringify(draft, null, 2)}\n`);
            cache = draft;
            return result;
        });
    }

    return { get, update };
}

module.exports = { createStore, emptyStore };
