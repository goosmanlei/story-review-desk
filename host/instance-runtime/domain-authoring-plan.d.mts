import type {AuthoringRoot} from './domain-authoring.mjs';
import type {SceneExcerptRef} from '../../app/story-review-types';
export function authoringBlocks(root:AuthoringRoot):Array<{id:string;type:string;speaker:string;performanceNote:string;text:string}>;
export function authoringBoundary(root:AuthoringRoot,side:'opening'|'ending'):SceneExcerptRef;
export function prepareAuthoringPlan(root:AuthoringRoot,roots:AuthoringRoot[],planId:string):import('../../app/episode-plan-context').EpisodePlanContent|null;
