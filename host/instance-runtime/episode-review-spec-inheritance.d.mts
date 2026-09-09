import type {ConfigurationBinding,ReviewSpec} from './configuration-model.mjs';
export type EpisodeReviewSpecInheritance={schemaVersion:'EPISODE_REVIEW_SPEC_INHERITANCE_V1';subjectId:string;parentEventId:string;parentEventSha256:string;parentCreativeRevisionId:string;parentConfigurationBindingHash:string;reviewSpecHash:string};
export function episodeReviewSpecSemantics(spec:ReviewSpec):Record<string,unknown>;
export function hasEpisodeReviewSpecInheritance(event:Record<string,unknown>):boolean;
export function episodeCandidateConfiguration(input:{model:object;events:Record<string,unknown>[];subjectId:string;creativeRevisionId:string;criteriaVersion?:string}):{reviewSpec?:ReviewSpec;configurationBinding?:ConfigurationBinding;reviewSpecInheritance?:EpisodeReviewSpecInheritance};
export function assertEpisodeReviewSpecInheritance(input:{event:Record<string,unknown>;model:object;events:Record<string,unknown>[]}):void;
