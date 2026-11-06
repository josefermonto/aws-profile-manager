'use strict';

/**
 * AWS IAM Identity Center (SSO) calls, ported from connect-inspector's
 * sso_api/ssoService.js. Uses the OAuth device authorization flow, so the
 * sign-in link can be approved in any browser (another one, or an AWS
 * WorkSpace), not only on this Mac:
 *
 *   1. Register this tool as a public OIDC client, allowed to use refresh
 *      tokens (once per SSO region, kept in memory).
 *   2. Start a device authorization for the portal's start URL.
 *   3. Poll for the token until the user approves.
 *   4. With the token: list accounts and roles, get role credentials, and
 *      refresh the token before it expires.
 *
 * Unlike connect-inspector, tokens never go to the browser: the caller writes
 * them to the CLI's token cache. Token and credential values are never logged.
 */
const { randomUUID } = require('node:crypto');
const {
    SSOOIDCClient, RegisterClientCommand, StartDeviceAuthorizationCommand, CreateTokenCommand,
} = require('@aws-sdk/client-sso-oidc');
const {
    SSOClient, ListAccountsCommand, ListAccountRolesCommand, GetRoleCredentialsCommand, LogoutCommand,
} = require('@aws-sdk/client-sso');
const { ValidationError } = require('../core/errors');

const CLIENT_NAME = 'aws-profile-manager';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_GRANT = 'refresh_token';
const SCOPES = ['sso:account:access'];
const REGISTRATION_MARGIN_MS = 60 * 60 * 1000;
const MAX_ACCOUNT_PAGES = 20;
const ROLE_LOOKUP_CONCURRENCY = 5;
const DISCOVERY_TIMEOUT_MS = 8000;

// Error names that mean the sign-in itself is over (as opposed to a network blip or a missing permission).
const SESSION_ENDED = new Set(['UnauthorizedException', 'ExpiredTokenException']);

/**
 * Whether AWS answered a refresh with a refusal (4xx, other than throttling):
 * the sign-in is over, its session length is up, it was revoked, or the client
 * registration expired. After a session ends IAM Identity Center answers
 * InvalidRequestException, so this goes by the HTTP status, not a list of names.
 * No answer at all (offline) or a 5xx is a blip, retried later.
 */
function refusedByAws(error) {
    const status = error?.$metadata?.httpStatusCode;
    return status >= 400 && status < 500 && status !== 429;
}

// The portal page loads assets from its region's CDN (assets.sso-portal.<region>.amazonaws.com);
// the newer portal form carries the region in its hostname (<id>.portal.<region>.app.aws).
const PORTAL_ASSET_REGION_RE = /sso-portal\.([a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d)\.amazonaws\.com/;
const PORTAL_HOST_REGION_RE = /\.portal\.([a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d)\.app\.aws$/i;

class SessionEndedError extends ValidationError {
    /** `code`: AWS's error name, for the log. */
    constructor(code = null) {
        super('The AWS SSO sign-in for this portal has ended. Sign in again.');
        this.name = 'SessionEndedError';
        this.code = code;
    }
}

function toValidationError(error, what) {
    const code = error?.name ?? 'UnknownError';
    if (SESSION_ENDED.has(code) && what !== 'start') return new SessionEndedError(code);
    if (code === 'InvalidRequestException' && what === 'start') {
        return new ValidationError("AWS didn't accept that start URL and region. Check them against your access portal.");
    }
    const result = code === 'ForbiddenException' || code === 'AccessDeniedException'
        ? new ValidationError(`AWS SSO refused to ${what}.`)
        : new ValidationError(`AWS SSO couldn't ${what}: ${code}`);
    result.code = code;
    return result;
}

async function collectPages(fetchPage, pick, what) {
    const items = [];
    let nextToken;
    let pages = 0;
    do {
        if (pages >= MAX_ACCOUNT_PAGES) break;
        let page;
        try {
            page = await fetchPage(nextToken);
        } catch (error) {
            throw toValidationError(error, what);
        }
        for (const item of pick(page) ?? []) items.push(item);
        nextToken = page.nextToken;
        pages += 1;
    } while (nextToken);
    return items;
}

async function mapLimited(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return out;
}

function createSsoService({
    oidcClient = (region) => new SSOOIDCClient({ region }),
    ssoClient = (region) => new SSOClient({ region }),
    fetchImpl = fetch,
    now = () => Date.now(),
} = {}) {
    const registrations = new Map(); // region → { clientId, clientSecret, expiresAt }
    const pending = new Map(); // flowId → { region, startUrl, clientId, clientSecret, expiresAtMs, deviceCode, context }

    async function clientRegistration(region) {
        const cached = registrations.get(region);
        if (cached && cached.expiresAt - REGISTRATION_MARGIN_MS > now()) return cached;
        let resp;
        try {
            resp = await oidcClient(region).send(new RegisterClientCommand({
                clientName: CLIENT_NAME, clientType: 'public', scopes: SCOPES, grantTypes: [DEVICE_GRANT, REFRESH_GRANT],
            }));
        } catch (error) {
            throw toValidationError(error, 'register this tool');
        }
        const registration = {
            clientId: resp.clientId,
            clientSecret: resp.clientSecret,
            expiresAt: (resp.clientSecretExpiresAt ?? 0) * 1000,
        };
        registrations.set(region, registration);
        return registration;
    }

    function prune() {
        for (const [id, flow] of pending) if (flow.expiresAtMs <= now()) pending.delete(id);
    }

    /**
     * Starts a sign-in: `{ flowId, userCode, verificationUri, expiresIn, interval }`.
     * `context` rides along and comes back with the finished sign-in.
     */
    async function startSignIn(startUrl, region, context = null) {
        prune();
        const registration = await clientRegistration(region);
        let resp;
        try {
            resp = await oidcClient(region).send(new StartDeviceAuthorizationCommand({
                clientId: registration.clientId, clientSecret: registration.clientSecret, startUrl,
            }));
        } catch (error) {
            throw toValidationError(error, 'start');
        }
        const flowId = randomUUID();
        const expiresIn = resp.expiresIn ?? 600;
        pending.set(flowId, {
            region, startUrl, context,
            clientId: registration.clientId,
            clientSecret: registration.clientSecret,
            registrationExpiresAt: registration.expiresAt,
            deviceCode: resp.deviceCode,
            expiresAtMs: now() + expiresIn * 1000,
        });
        return {
            flowId,
            userCode: resp.userCode ?? null,
            verificationUri: resp.verificationUriComplete ?? resp.verificationUri ?? null,
            expiresIn,
            interval: resp.interval ?? 5,
        };
    }

    /**
     * `{ status: 'pending' }` until approved, then `{ status: 'done', token, context }`
     * where `token` is ready for the token cache. 'expired' / 'denied' end it.
     */
    async function pollSignIn(flowId) {
        prune();
        const flow = pending.get(flowId);
        if (!flow) return { status: 'expired' };
        let resp;
        try {
            resp = await oidcClient(flow.region).send(new CreateTokenCommand({
                clientId: flow.clientId, clientSecret: flow.clientSecret, grantType: DEVICE_GRANT, deviceCode: flow.deviceCode,
            }));
        } catch (error) {
            const code = error?.name;
            if (code === 'AuthorizationPendingException') return { status: 'pending' };
            if (code === 'SlowDownException') return { status: 'pending', slowDown: true };
            pending.delete(flowId);
            if (code === 'ExpiredTokenException') return { status: 'expired' };
            if (code === 'AccessDeniedException') return { status: 'denied' };
            throw toValidationError(error, 'finish signing in');
        }
        pending.delete(flowId);
        return {
            status: 'done',
            context: flow.context,
            token: {
                startUrl: flow.startUrl,
                region: flow.region,
                accessToken: resp.accessToken,
                expiresAt: new Date(now() + (resp.expiresIn ?? 3600) * 1000).toISOString(),
                refreshToken: resp.refreshToken,
                clientId: flow.clientId,
                clientSecret: flow.clientSecret,
                registrationExpiresAt: flow.registrationExpiresAt ? new Date(flow.registrationExpiresAt).toISOString() : undefined,
            },
        };
    }

    /** A renewed cache token, from its refresh token. Throws SessionEndedError when AWS refuses (the sign-in is over). */
    async function refresh(token) {
        if (!token.refreshToken || !token.clientId || !token.clientSecret) throw new SessionEndedError();
        let resp;
        try {
            resp = await oidcClient(token.region).send(new CreateTokenCommand({
                clientId: token.clientId, clientSecret: token.clientSecret, grantType: REFRESH_GRANT, refreshToken: token.refreshToken,
            }));
        } catch (error) {
            if (refusedByAws(error)) throw new SessionEndedError(error.name);
            throw toValidationError(error, 'renew the sign-in');
        }
        return {
            ...token,
            accessToken: resp.accessToken,
            expiresAt: new Date(now() + (resp.expiresIn ?? 3600) * 1000).toISOString(),
            refreshToken: resp.refreshToken ?? token.refreshToken,
        };
    }

    /** `{ accounts: [{ accountId, accountName, email, roles: [...] }] }`, sorted by name. */
    async function listAccounts(accessToken, region) {
        const client = ssoClient(region);
        const accounts = await collectPages(
            (nextToken) => client.send(new ListAccountsCommand({ accessToken, nextToken, maxResults: 100 })),
            (page) => page.accountList,
            'list your accounts',
        );
        const withRoles = await mapLimited(accounts, ROLE_LOOKUP_CONCURRENCY, async (account) => {
            const roles = await collectPages(
                (nextToken) => client.send(new ListAccountRolesCommand({ accessToken, accountId: account.accountId, nextToken })),
                (page) => page.roleList,
                'list your roles',
            );
            return {
                accountId: account.accountId,
                accountName: account.accountName ?? account.accountId,
                email: account.emailAddress ?? null,
                roles: roles.map((r) => r.roleName).filter(Boolean).sort(),
            };
        });
        return { accounts: withRoles.sort((a, b) => a.accountName.localeCompare(b.accountName)) };
    }

    /** `{ credentials: { accessKeyId, secretAccessKey, sessionToken }, expiresAt }` for one account and role. */
    async function roleCredentials(accessToken, region, accountId, roleName) {
        let resp;
        try {
            resp = await ssoClient(region).send(new GetRoleCredentialsCommand({ accessToken, accountId, roleName }));
        } catch (error) {
            throw toValidationError(error, `get credentials for ${roleName}`);
        }
        const c = resp.roleCredentials ?? {};
        if (!c.accessKeyId || !c.secretAccessKey || !c.sessionToken) throw new ValidationError('AWS SSO returned incomplete credentials.');
        return {
            credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken },
            expiresAt: new Date(c.expiration ?? now() + 3600 * 1000).toISOString(),
        };
    }

    /** Ends the sign-in on AWS's side too. Best effort: a failure here doesn't matter locally. */
    async function logout(accessToken, region) {
        try {
            await ssoClient(region).send(new LogoutCommand({ accessToken }));
        } catch {
            // already invalid, or offline
        }
    }

    /** `{ region }` behind a portal URL, or `{ region: null }` when it can't be told. */
    async function discoverRegion(startUrl) {
        const fromHost = new URL(startUrl).hostname.match(PORTAL_HOST_REGION_RE);
        if (fromHost) return { region: fromHost[1].toLowerCase() };
        let html;
        try {
            const resp = await fetchImpl(`${startUrl}/`, { redirect: 'follow', signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
            if (!resp.ok) return { region: null };
            html = await resp.text();
        } catch {
            return { region: null };
        }
        const match = html.match(PORTAL_ASSET_REGION_RE);
        return { region: match ? match[1] : null };
    }

    return { startSignIn, pollSignIn, refresh, listAccounts, roleCredentials, logout, discoverRegion };
}

module.exports = { createSsoService, SessionEndedError, refusedByAws };
