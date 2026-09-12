export const ROOT_GUIDANCE_ALIASES: readonly ['README.md', 'AGENTS.md', 'STATE.md'];
export const TOPIC_GUIDANCE_ALIASES: readonly ['guidance/story-review.md', 'guidance/materials.md', 'guidance/production.md', 'guidance/review-ui.md', 'guidance/operations.md'];
export const GUIDANCE_ALIASES: readonly string[];
export function allowedGuidanceRole(document: {metadata: Record<string, unknown>}, alias: string): boolean;
