export type ImagePurpose = 'BASE_REFERENCE' | 'PREVIS_STILL' | 'PRODUCTION_FRAME';
export type ImagePurposeProfiles = {
 schemaVersion:'IMAGE_TECHNICAL_SPEC_V1';
 BASE_REFERENCE:{dimensionPolicy:'NATIVE_ORIGINAL';formats:['PNG']};
 PREVIS_STILL:{dimensionPolicy:'NATIVE_ORIGINAL';formats:['PNG']};
 PRODUCTION_FRAME:{dimensionPolicy:'EXACT_PROJECT_CANVAS';formats:['PNG']};
};
export type ImageTechnicalSpec = {
 schemaVersion:'IMAGE_TECHNICAL_SPEC_V1';purpose:ImagePurpose;mediaType:'IMAGE';
 dimensionPolicy:'NATIVE_ORIGINAL'|'EXACT_PROJECT_CANVAS';formats:['PNG'];
 intrinsicFps:'NOT_APPLICABLE';frameCount:1;
 canvas:null|{aspectRatio:string;width:number|'UNKNOWN';height:number|'UNKNOWN';fps:number|'UNKNOWN';confirmation:string};
};
export type ImageTechnicalBinding = {technicalSpec:ImageTechnicalSpec;technicalSpecHash:string};
export type ImageTechnicalFacts = {schemaVersion:'IMAGE_TECHNICAL_FACTS_V1';sha256:string;byteSize:number;format:'PNG';width:number;height:number;frameCount:1};
export const IMAGE_TECHNICAL_SPEC_SCHEMA:'IMAGE_TECHNICAL_SPEC_V1';
export function defaultImagePurposeProfiles():ImagePurposeProfiles;
export function validateImagePurposeProfiles(value:unknown):ImagePurposeProfiles;
export function imageTechnicalPurpose(kind:string,object:unknown):ImagePurpose|null;
export function createImageTechnicalSpec(config:unknown,kind:string,object:unknown):ImageTechnicalBinding|null;
export function imageTechnicalReviewText(spec:ImageTechnicalSpec):string;
export function imageTechnicalBinding(binding:unknown):ImageTechnicalBinding|null;
export function resolveImageTechnicalSpec(model:unknown,input:{familyId:string;workItemId?:string;expectedOutputId?:string;definition?:unknown}):ImageTechnicalBinding|null;
export function inspectPngImage(bytes:Buffer):{format:'PNG';width:number;height:number;frameCount:1};
export function readImageTechnicalFacts(filePath:string,input:{sha256:string;byteSize?:number}):Promise<ImageTechnicalFacts>;
export function assertImageTechnicalApproval(binding:unknown,facts:unknown):void;
