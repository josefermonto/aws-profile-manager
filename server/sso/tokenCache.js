'use strict';

/**
 * The SSO token cache the AWS CLI and SDKs share: ~/.aws/sso/cache/<sha1 of
 * the sso-session name>.json. Writing a sign-in here is what makes every
 * `[profile]` with `sso_session = <name>` work in the CLI, CDK, boto3 and the
 * JS SDK, and the refresh token in it lets them renew the sign-in on their own.
 */
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readText, mtimeMs, writeAtomic } = require('../core/fsx');

function cacheFile(dir, sessionName) {
    const hash = crypto.createHash('sha1').update(sessionName, 'utf8').digest('hex');
    return path.join(dir, `${hash}.json`);
}

/** The CLI writes timestamps without milliseconds; match it so every reader parses them. */
const isoSeconds = (value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');

function createTokenCache({ dir }) {
    /** `{ token, mtime }` for the session, or null when there's no (readable) sign-in. */
    async function read(sessionName) {
        const file = cacheFile(dir, sessionName);
        const text = await readText(file);
        if (!text) return null;
        try {
            const token = JSON.parse(text);
            if (!token?.accessToken || !token?.expiresAt) return null;
            return { token, mtime: await mtimeMs(file) };
        } catch {
            return null;
        }
    }

    /** Saves a sign-in in the CLI's format. */
    async function write(sessionName, token) {
        const body = {
            startUrl: token.startUrl,
            region: token.region,
            accessToken: token.accessToken,
            expiresAt: isoSeconds(token.expiresAt),
            clientId: token.clientId,
            clientSecret: token.clientSecret,
            registrationExpiresAt: token.registrationExpiresAt ? isoSeconds(token.registrationExpiresAt) : undefined,
            refreshToken: token.refreshToken,
        };
        await writeAtomic(cacheFile(dir, sessionName), JSON.stringify(body));
    }

    async function remove(sessionName) {
        await fs.rm(cacheFile(dir, sessionName), { force: true });
    }

    return { read, write, remove, file: (sessionName) => cacheFile(dir, sessionName) };
}

module.exports = { createTokenCache, cacheFile, isoSeconds };
