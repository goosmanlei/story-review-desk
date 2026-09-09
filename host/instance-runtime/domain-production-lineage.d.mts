export type DomainProductionProof={authorizedSequence:number;submittedSequence:number;candidateSequence:number;inputs:Array<{familyId:string;versionId:string;sha256:string}>};
export function domainProductionProofs(input:{candidates?:unknown[];requests?:unknown[];runs?:unknown[];versions:Map<string,unknown>;allowInputless?:boolean}):Map<string,DomainProductionProof>;
