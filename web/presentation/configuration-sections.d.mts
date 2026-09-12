export type ConfigurationGroup = 'technical'|'interface'|'sources'|'entities'|'references'|'taxonomy'|'workflow'|'review'|'assistant'|'codex'|'trial';
export const CONFIGURATION_SECTIONS: ReadonlyArray<{id:string;label:string;groups:Array<[ConfigurationGroup,string]>}>;
