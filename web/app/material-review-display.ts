/** Reading-only normalization. Never changes criterion IDs, findings, rights or evidence. */
export function materialDisplayText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return /^(?:UNKNOWN|UNDEFINED|NULL|N\/A|[-—–]+)$/i.test(text) ? '' : text;
}
const comparable = (value: unknown) => materialDisplayText(value).replace(/\s+/g, ' ').replace(/[。.!！?？:：;；]+$/, '');
export function materialCriterionDescription(label: unknown, description: unknown): string {
  const text = materialDisplayText(description);
  return comparable(text) === comparable(label) ? '' : text;
}
type ReviewReadingSource = {
  reviewSpec?: { criteria?: Array<{ label?: string; question?: unknown }> };
  acceptanceCriteria?: string[];
  storyBasis?: { onScreenRequirement?: string; factBoundary?: string };
};
export function materialExtraReviewPoints(requirement: ReviewReadingSource): string[] {
  const criteria = requirement.reviewSpec?.criteria || [];
  // Legacy acceptance entries are themselves the formal criteria, not an extra checklist.
  const formal = requirement.reviewSpec?.criteria ? criteria.flatMap(c => [c.label, c.question]) : requirement.acceptanceCriteria || [];
  const seen = new Set(formal.map(comparable).filter(Boolean));
  return [...(requirement.acceptanceCriteria || []), requirement.storyBasis?.onScreenRequirement, requirement.storyBasis?.factBoundary]
    .map(materialDisplayText).filter(text => {
      const key = comparable(text);
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
}
