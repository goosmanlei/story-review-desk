/** Consume server disposition; a browser page is not the full replacement graph. */
import {runtimePath} from './runtime-path';
type MaterialDispositionRow = {
  requirementClass?: string;
  currentDisposition?: string;
  composition?: unknown;
  replaces?: unknown;
  requirementReplacement?: {protocol?: string; status?: string; replacedByRequirementId?: string | null};
};

export function currentMaterialDirectoryRow(row: MaterialDispositionRow): boolean {
  if (row.requirementClass !== 'REQUIRED') return false;
  if (row.currentDisposition !== undefined) {
    return (row.currentDisposition === 'CURRENT_ATOMIC' || row.currentDisposition === 'CURRENT_AGGREGATE')
      && row.requirementReplacement?.protocol === 'MATERIAL_REQUIREMENT_REPLACEMENT_V1'
      && row.requirementReplacement.status === 'VALID';
  }
  return row.replaces === undefined && row.requirementReplacement === undefined;
}

export function atomicMaterialDirectoryRow(row: MaterialDispositionRow): boolean {
  return currentMaterialDirectoryRow(row) && !row.composition && row.currentDisposition !== 'CURRENT_AGGREGATE';
}

export function materialRequirementLink(requirementId: string): string {
  return runtimePath('/?' + new URLSearchParams({view:'materials', material:requirementId, materialPanel:'material'}).toString());
}
