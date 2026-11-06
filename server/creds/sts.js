'use strict';

/**
 * Checks keys with sts:GetCallerIdentity, which needs no IAM permissions and
 * costs nothing. It's how pasted keys get a real status: the session token
 * doesn't say when it expires, but STS does say when it has.
 */
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { IAMClient, GetRoleCommand } = require('@aws-sdk/client-iam');

const EXPIRED = new Set(['ExpiredToken', 'ExpiredTokenException', 'RequestExpired']);
const INVALID = new Set(['InvalidClientTokenId', 'SignatureDoesNotMatch', 'UnrecognizedClientException', 'AccessDenied', 'AccessDeniedException', 'IncompleteSignature']);

const SSO_ROLE_RE = /:assumed-role\/AWSReservedSSO_(.+)_[0-9a-f]{16}\//;
const ROLE_RE = /:assumed-role\/([^/]+)\//;
const USER_RE = /:user\/(.+)$/;

/** The role (or IAM user) behind a caller ARN, readable: "AdministratorAccess", "user/ci". */
function principalName(arn) {
    const sso = SSO_ROLE_RE.exec(arn ?? '');
    if (sso) return sso[1];
    const role = ROLE_RE.exec(arn ?? '');
    if (role) return role[1];
    const user = USER_RE.exec(arn ?? '');
    return user ? `user/${user[1]}` : null;
}

function createSts({
    client = (region, credentials) => new STSClient({ region, credentials, maxAttempts: 2 }),
    iamClient = (credentials) => new IAMClient({ region: 'us-east-1', credentials, maxAttempts: 1 }),
} = {}) {
    const asSdk = (c) => ({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken || undefined });

    /**
     * `{ ok: true, accountId, arn, principal }`, or
     * `{ ok: false, code: 'expired' | 'invalid' | 'unreachable', message }`.
     * 'unreachable' means "couldn't tell" (offline, timeout): keep the old status.
     */
    async function check(credentials, region = 'us-east-1') {
        try {
            const resp = await client(region, {
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey,
                sessionToken: credentials.sessionToken || undefined,
            }).send(new GetCallerIdentityCommand({}));
            return { ok: true, accountId: resp.Account, arn: resp.Arn, principal: principalName(resp.Arn) };
        } catch (error) {
            const name = error?.name ?? error?.Code ?? 'Error';
            if (EXPIRED.has(name)) return { ok: false, code: 'expired', message: 'These credentials have expired.' };
            if (INVALID.has(name)) return { ok: false, code: 'invalid', message: 'AWS rejected these keys (wrong, deleted or deactivated).' };
            return { ok: false, code: 'unreachable', message: `Couldn't reach AWS STS to check the keys (${name}).` };
        }
    }

    /**
     * The role's maximum session length in ms (iam:GetRole, read with the
     * keys themselves), or null when the role isn't allowed to read it.
     */
    async function roleMaxSession(credentials, roleName) {
        try {
            const resp = await iamClient(asSdk(credentials)).send(new GetRoleCommand({ RoleName: roleName }));
            const seconds = resp.Role?.MaxSessionDuration;
            return seconds ? seconds * 1000 : null;
        } catch {
            return null;
        }
    }

    return { check, roleMaxSession };
}

module.exports = { createSts, principalName };
