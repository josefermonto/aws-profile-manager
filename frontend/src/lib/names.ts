/** Profile-name suggestions; the same rules as server/core/names.js. */
import type { LabelColor } from '../types';

export function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const ROLE_SHORT: Record<string, string> = {
  administratoraccess: 'admin',
  poweruseraccess: 'poweruser',
  readonlyaccess: 'readonly',
  viewonlyaccess: 'viewonly',
  billing: 'billing',
};

export function roleSlug(role: string): string {
  return ROLE_SHORT[role.toLowerCase()] ?? (slug(role.replace(/Access$/, '')) || 'role');
}

export function suggestName(project: string, env: string, role: string): string {
  return [slug(project), slug(env), roleSlug(role)].filter(Boolean).join('-');
}

/**
 * A label for an AWS account from its name: "acme-prod-workloads" → "Prod",
 * "Acme Shared Services" → "Shared". Otherwise the name without the project's
 * own prefix ("acme-data-lake" in project Acme → "Data Lake").
 */
const LABEL_WORDS: [RegExp, string][] = [
  [/\b(prod|production|prd|live)\b/, 'Prod'],
  [/\b(staging|stage|stg)\b/, 'Staging'],
  [/\b(uat|preprod)\b/, 'UAT'],
  [/\b(qa|qat)\b/, 'QA'],
  [/\b(test|testing|tst|sit)\b/, 'Test'],
  [/\b(dev|development|develop)\b/, 'Dev'],
  [/\b(sandbox|sbx|playground)\b/, 'Sandbox'],
  [/\b(security|audit|secops)\b/, 'Security'],
  [/\b(log|logs|logging|archive)\b/, 'Logs'],
  [/\b(network|networking|transit)\b/, 'Network'],
  [/\b(shared|services|common)\b/, 'Shared'],
  [/\b(management|master|root|payer|billing)\b/, 'Management'],
];

const ENDS_WITH: [RegExp, string][] = [
  [/(prod|production|prd)$/, 'Prod'], [/(staging|stg)$/, 'Staging'], [/uat$/, 'UAT'], [/qa$/, 'QA'],
  [/test$/, 'Test'], [/(dev|development)$/, 'Dev'], [/(sandbox|sbx)$/, 'Sandbox'],
];

export function guessLabel(accountName: string, projectName = ''): string {
  // Split camelCase and ALLCAPSWords first: "AcmeAWSOwnerDataPlatformProd" → "Acme AWS Owner Data Platform Prod".
  const spaced = accountName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const words = spaced.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [re, label] of LABEL_WORDS) if (re.test(words)) return label;
  const squashed = words.replace(/ /g, '');
  for (const [re, label] of ENDS_WITH) if (re.test(squashed)) return label;
  const prefix = slug(projectName).replace(/-/g, ' ');
  const rest = prefix && words.startsWith(prefix) ? words.slice(prefix.length).trim() : words;
  return (rest || words).replace(/\b\w/g, c => c.toUpperCase()).slice(0, 20);
}

const LABEL_COLOR: Record<string, LabelColor> = {
  prod: 'red', staging: 'orange', uat: 'orange', qa: 'blue', test: 'blue', dev: 'green', sandbox: 'yellow',
  security: 'purple', logs: 'teal', network: 'teal', shared: 'teal', management: 'pink',
};
const SPREAD: LabelColor[] = ['purple', 'teal', 'pink', 'blue', 'yellow', 'green', 'orange'];

/** A color for a label: the usual ones (Prod red, Dev green…); others spread over the palette so they differ. */
export function guessColor(label: string): LabelColor | null {
  if (!label) return null;
  const known = LABEL_COLOR[label.toLowerCase()];
  if (known) return known;
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SPREAD[hash % SPREAD.length];
}

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const NAME_RULE = 'Letters, digits, dots, dashes and underscores; starts with a letter or digit.';

/** The account and role from the portal's "[123456789012_RoleName]" credentials header, if pasted. */
export function portalHeader(blob: string): { accountId: string; roleName: string } | null {
  const m = /^\s*\[(\d{12})_([^\]\s]+)\]\s*$/m.exec(blob);
  return m ? { accountId: m[1], roleName: m[2] } : null;
}
