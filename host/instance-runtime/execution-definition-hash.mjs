import {canonicalJson,sha256} from './bytes.mjs';

export const SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA='SHOT_PRODUCTION_SOURCE_V1';
const sourceEnvelope=new Set(['definitionHash','sourceRef','sourceRevisionId','sourceSha256']);
const legacyEnvelope=new Set(['definitionHash','currentRevisionId']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactSha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)?value.toLowerCase():null;

// The first shot-production author predates the explicit schema marker. Its
// immutable source includes currentRevisionId; publication adds only these three
// source-envelope fields. Identify that producer, never try hashes until one fits.
function unversionedShotSource(definition){
 return /^SP-CALL-[a-f0-9]{24}$/.test(definition.id||'')
  &&definition.executorKind==='MODEL_CALL'
  &&definition.currentRevisionId===definition.id+':r1'
  &&typeof definition.workItemRef==='string'&&Boolean(definition.workItemRef)
  &&object(definition.authoringContent)&&object(definition.productionBasis)
  &&Boolean(exactSha(definition.productionBasisHash));
}

/** Compute an execution hash without rewriting frozen source or catalog rows. */
export function executionDefinitionHash(definition){
 if(!object(definition))throw new TypeError('Execution definition must be an object');
 const hasSchema=Object.prototype.hasOwnProperty.call(definition,'definitionHashSchemaVersion');
 if(hasSchema&&definition.definitionHashSchemaVersion!==SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA)throw new TypeError('Unsupported execution definition hash schema');
 const shotSource=hasSchema||unversionedShotSource(definition);
 const omitted=shotSource?sourceEnvelope:legacyEnvelope;
 // Every other field, including unrecognized additions, remains hash-bound.
 return sha256(canonicalJson(Object.fromEntries(Object.entries(definition).filter(([key])=>!omitted.has(key)))));
}

/** Evidence reads fail closed for malformed/unknown schemas without a 500. */
export function inspectExecutionDefinitionHash(definition){
 const declaredHash=exactSha(definition?.definitionHash);
 let calculatedHash=null;
 try{calculatedHash=executionDefinitionHash(definition);}catch{}
 return {declaredHash,calculatedHash,valid:Boolean(declaredHash&&calculatedHash===declaredHash)};
}
