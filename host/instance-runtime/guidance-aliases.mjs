// Fixed project-guidance namespace; never a general source-file allowlist.
export const ROOT_GUIDANCE_ALIASES = Object.freeze(['README.md', 'AGENTS.md', 'STATE.md']);
export const TOPIC_GUIDANCE_ALIASES = Object.freeze([
  'guidance/story-review.md', 'guidance/materials.md', 'guidance/production.md',
  'guidance/review-ui.md', 'guidance/operations.md',
]);
export const GUIDANCE_ALIASES = Object.freeze([...ROOT_GUIDANCE_ALIASES, ...TOPIC_GUIDANCE_ALIASES]);
export function allowedGuidanceRole(document, alias) {
  const metadata = document.metadata || {}, role = metadata.sourceRole;
  if (TOPIC_GUIDANCE_ALIASES.includes(alias)) return role === 'PROJECT_GUIDANCE';
  if (!ROOT_GUIDANCE_ALIASES.includes(alias)) return false;
  if (['INSTANCE_GUIDANCE', 'PROJECT_GUIDANCE'].includes(role)) return true;
  const legacyRole = alias === 'AGENTS.md' ? 'PROJECT_RULE_SOURCE' : alias === 'STATE.md' ? 'MACHINE_MODEL_SOURCE' : null;
  return Boolean(legacyRole && role === legacyRole && metadata.migrationRebase === 'GUIDANCE_REBASE_TO_ACTUAL_BYTES' && /^[a-f0-9]{64}$/.test(metadata.legacyExpectedSha256 || ''));
}
