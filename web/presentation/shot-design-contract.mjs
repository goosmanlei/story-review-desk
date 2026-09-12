// V3 is an additive, explicitly selected design contract. Never normalize old
// candidate bytes through this module or turn an estimate into a timing lock.
export const SHOT_SIZES = Object.freeze(['EXTREME_WIDE','WIDE','FULL','MEDIUM','CLOSE_UP','EXTREME_CLOSE_UP','UNKNOWN']);
export const CAMERA_ANGLES = Object.freeze(['EYE_LEVEL','HIGH','LOW','OVER_SHOULDER','POV','TOP_DOWN','DUTCH','OTHER','UNKNOWN']);
export const CAMERA_MOVEMENTS = Object.freeze(['STATIC','PUSH','PULL','PAN','TILT','TRACK','FOLLOW','HANDHELD','CRANE','ORBIT','OTHER','UNKNOWN']);
export const KEYFRAME_STRATEGIES = Object.freeze(['UNDECIDED','START_ONLY','START_END','MULTI_KEYFRAME']);
export function isRequirementDrivenPlanningVersion(version) { return version === '2.0' || version === '3.0'; }
export function planningReviewVersion(version) { return isRequirementDrivenPlanningVersion(version) ? version : '1.0'; }
function fail(path, message) { throw Object.assign(new Error(`${path}: ${message}`), {code:'SHOT_DESIGN_VALIDATION_FAILED'}); }
function exact(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) fail(path,'字段必须完整且不能加入未定义字段');
  return value;
}
function text(value,path) { if (typeof value !== 'string' || !value.trim() || value.length > 20000) fail(path,'请填写明确内容或 UNKNOWN'); return value.trim(); }
function enumValue(value,values,path) { if (!values.includes(value)) fail(path,'不是已定义的选项'); return value; }
function identity(value,path) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,299}$/.test(value)) fail(path,'永久身份格式无效'); return value; }
export function canonicalShotDesign(value,path='design') {
  const d=exact(value,['shotSize','cameraAngle','cameraMovement','composition','performance','lighting','estimatedDurationSeconds','subjectIds','continuity','keyframeStrategy'],path);
  const duration=d.estimatedDurationSeconds;
  if (duration !== null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0)) fail(`${path}.estimatedDurationSeconds`,'估时必须为正秒数，未知使用 null');
  if (!Array.isArray(d.subjectIds) || d.subjectIds.length > 200 || new Set(d.subjectIds).size !== d.subjectIds.length) fail(`${path}.subjectIds`,'主体身份必须为不重复的数组');
  const c=exact(d.continuity,['startState','endState','previousShotId','nextShotId','transitionIn','transitionOut'],`${path}.continuity`);
  const k=exact(d.keyframeStrategy,['mode','reason','intermediateFrameCount'],`${path}.keyframeStrategy`);
  const mode=enumValue(k.mode,KEYFRAME_STRATEGIES,`${path}.keyframeStrategy.mode`);
  if (!Number.isSafeInteger(k.intermediateFrameCount) || (mode === 'MULTI_KEYFRAME' ? k.intermediateFrameCount < 1 || k.intermediateFrameCount > 100 : k.intermediateFrameCount !== 0)) fail(`${path}.keyframeStrategy.intermediateFrameCount`,'多关键帧需要 1–100 张中间帧，其他策略为 0');
  return {
    shotSize:enumValue(d.shotSize,SHOT_SIZES,`${path}.shotSize`),cameraAngle:enumValue(d.cameraAngle,CAMERA_ANGLES,`${path}.cameraAngle`),cameraMovement:enumValue(d.cameraMovement,CAMERA_MOVEMENTS,`${path}.cameraMovement`),
    composition:text(d.composition,`${path}.composition`),performance:text(d.performance,`${path}.performance`),lighting:text(d.lighting,`${path}.lighting`),estimatedDurationSeconds:duration,
    subjectIds:d.subjectIds.map((id,index)=>identity(id,`${path}.subjectIds[${index}]`)),
    continuity:{startState:text(c.startState,`${path}.continuity.startState`),endState:text(c.endState,`${path}.continuity.endState`),previousShotId:c.previousShotId===null?null:identity(c.previousShotId,`${path}.continuity.previousShotId`),nextShotId:c.nextShotId===null?null:identity(c.nextShotId,`${path}.continuity.nextShotId`),transitionIn:text(c.transitionIn,`${path}.continuity.transitionIn`),transitionOut:text(c.transitionOut,`${path}.continuity.transitionOut`)},
    keyframeStrategy:{mode,reason:text(k.reason,`${path}.keyframeStrategy.reason`),intermediateFrameCount:k.intermediateFrameCount},
  };
}
