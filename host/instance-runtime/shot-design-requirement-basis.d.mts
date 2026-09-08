export const SHOT_DESIGN_REQUIREMENT_BASIS_VERSION:'3.0';
export const SHOT_DESIGN_REQUIREMENT_SEMANTIC_POLICY:'SHOT_DESIGN_REQUIREMENT_SEMANTICS_V1';
export type ShotDesignRequirementSemanticBinding={requirementId:string;requirementSemanticHash:string;acceptanceCriteria:unknown[];authority:unknown;requirement:Record<string,unknown>;demand:Record<string,unknown>|null;conditions:Record<string,unknown>;directoryOwnership:Record<string,unknown>|null;graphClosure:Record<string,unknown>;requiredComponents?:Array<{id:string;requirementId:string;binding:ShotDesignRequirementSemanticBinding}>};
export type ShotDesignRequirementBasisV3={id:string;schemaVersion:'3.0';semanticPolicy:'SHOT_DESIGN_REQUIREMENT_SEMANTICS_V1';sceneId:string;coverageRevisionId:string;coverageContentHash:string;bindings:ShotDesignRequirementSemanticBinding[];contentHash:string};
export function deriveShotDesignRequirementBasisV3(model:Record<string,unknown>,sceneId:string):ShotDesignRequirementBasisV3;
export function shotDesignRequirementBasisSchema(frozen:unknown):'2.0'|'3.0';
export function assertShotDesignRequirementBasisV3Current(model:Record<string,unknown>,sceneId:string,frozen:unknown):ShotDesignRequirementBasisV3;
