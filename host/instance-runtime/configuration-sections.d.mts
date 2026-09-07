export type ConfigurationGroup = 'technical'|'sources'|'entities'|'references'|'taxonomy'|'workflow'|'review'|'general';
export const CONFIGURATION_SECTIONS: ReadonlyArray<{id:string;label:string;groups:Array<[ConfigurationGroup,string]>}>;
