export type Criterion = {
  id: string;
  label: string;
  question: string;
  required?: boolean;
  allowNA?: boolean;
  noteRequiredOnFail?: boolean;
};
export function reviewCriteria(item: unknown, context: unknown): Criterion[];
export function criteriaForReviewScope(
  item: unknown,
  shotContext: unknown,
  context: unknown,
): Criterion[];
