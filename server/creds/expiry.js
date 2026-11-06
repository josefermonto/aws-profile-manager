'use strict';

/**
 * How long pasted temporary keys last. The keys don't carry their expiry and
 * STS doesn't report it, but the kind of session that issued them does:
 *
 *   - IAM Identity Center (role AWSReservedSSO_<permission set>_<hash>): the
 *     role's MaxSessionDuration is the permission set's session duration, which
 *     is exactly what the access portal issues. Read with iam:GetRole, when allowed.
 *   - Otherwise, how long this role's keys lasted last time (learned when STS
 *     first reported them expired), else the AWS default for the session type:
 *     1 h for AssumeRole, 12 h for GetSessionToken / GetFederationToken.
 */
const HOUR_MS = 3600 * 1000;
const QUARTER_MS = 15 * 60 * 1000;

const SSO_ROLE_RE = /:assumed-role\/(AWSReservedSSO_[^/]+)\//;
const ROLE_RE = /:assumed-role\/([^/]+)\//;

function defaultLifetime(arn) {
    if (/:federated-user\//.test(arn ?? '') || /:user\//.test(arn ?? '')) return 12 * HOUR_MS;
    return HOUR_MS;
}

/** The key that learned lifetimes are kept under: one per account and role (or user). */
function lifetimeKey(accountId, arn) {
    const role = ROLE_RE.exec(arn ?? '')?.[1];
    const principal = role ?? (arn ?? '').split(':').pop();
    return accountId && principal ? `${accountId}:${principal}` : null;
}

/** Observed lifetimes are a few minutes short (keys are issued before they're pasted): round to the quarter hour. */
function snapLifetime(ms) {
    return Math.max(QUARTER_MS, Math.round(ms / QUARTER_MS) * QUARTER_MS);
}

/**
 * `{ ms, basis: 'role' | 'learned' | 'default', key }` for keys STS identified as `check`.
 * `readRoleMax(roleName)` resolves to the role's max session in ms, or null.
 */
async function detectLifetime(check, learned, readRoleMax) {
    const arn = check.ok ? check.arn : null;
    const key = check.ok ? lifetimeKey(check.accountId, arn) : null;
    const ssoRole = SSO_ROLE_RE.exec(arn ?? '')?.[1];
    if (ssoRole) {
        const ms = await readRoleMax(ssoRole);
        if (ms) return { ms, basis: 'role', key };
    }
    if (key && learned?.[key]) return { ms: learned[key], basis: 'learned', key };
    return { ms: defaultLifetime(arn), basis: 'default', key };
}

module.exports = { detectLifetime, defaultLifetime, lifetimeKey, snapLifetime };
