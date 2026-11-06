'use strict';

/** Naming rules for profiles, SSO sessions and the shell prompt tag. */
const crypto = require('node:crypto');

/** Lowercase, ASCII, dash-separated: "Acme Corp (EU)" → "acme-corp-eu". */
function slug(text) {
    return String(text ?? '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

const ROLE_SHORT = {
    administratoraccess: 'admin',
    poweruseraccess: 'poweruser',
    readonlyaccess: 'readonly',
    viewonlyaccess: 'viewonly',
    billing: 'billing',
};

/** "AdministratorAccess" → "admin", "DeveloperAccess" → "developer". */
function roleSlug(roleName) {
    const known = ROLE_SHORT[String(roleName).toLowerCase()];
    if (known) return known;
    return slug(String(roleName).replace(/Access$/, '')) || 'role';
}

/** `<project>-<env>-<role>`, e.g. acme-prod-admin. */
function suggestProfileName(projectName, envName, roleName) {
    return [slug(projectName), slug(envName), roleSlug(roleName)].filter(Boolean).join('-');
}

// New names are kept shell-safe so `export AWS_PROFILE=<name>` and `awspm use <name>` need no quoting.
const NEW_PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Adopted profiles keep whatever name the files already use, within what an INI header can hold.
const EXISTING_PROFILE_NAME_RE = /^[^\][\r\n]{1,128}$/;

/** The sibling profile that carries plain keys for an SSO profile ("also write plain keys"). */
const keysProfileName = (name) => `${name}-keys`;

/** The prompt tag text: letters, digits, spaces, dot, dash, underscore only (it's printed by zsh). */
function promptTag(...parts) {
    return parts
        .filter(Boolean)
        .join(' ')
        .toUpperCase()
        .replace(/[^A-Z0-9 ._-]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 32);
}

const newId = () => crypto.randomUUID();

module.exports = {
    slug, roleSlug, suggestProfileName, keysProfileName, promptTag, newId,
    NEW_PROFILE_NAME_RE, EXISTING_PROFILE_NAME_RE,
};
