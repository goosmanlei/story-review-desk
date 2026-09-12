export const SHOT_SIZES: readonly string[];
export const CAMERA_ANGLES: readonly string[];
export const CAMERA_MOVEMENTS: readonly string[];
export const KEYFRAME_STRATEGIES: readonly string[];
export type ShotDesign = {
  shotSize:string; cameraAngle:string; cameraMovement:string; composition:string; performance:string; lighting:string;
  estimatedDurationSeconds:number|null; subjectIds:string[];
  continuity:{startState:string;endState:string;previousShotId:string|null;nextShotId:string|null;transitionIn:string;transitionOut:string};
  keyframeStrategy:{mode:'UNDECIDED'|'START_ONLY'|'START_END'|'MULTI_KEYFRAME';reason:string;intermediateFrameCount:number};
};
export function isRequirementDrivenPlanningVersion(version:unknown):boolean;
export function planningReviewVersion(version:unknown):'1.0'|'2.0'|'3.0';
export function canonicalShotDesign(value:unknown,path?:string):ShotDesign;
