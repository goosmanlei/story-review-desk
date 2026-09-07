import {createHash} from 'node:crypto';

/** Same byte sequence as canonicalJson(), without joining the complete archive. */
export function canonicalSha256(value) {
 const hash=createHash('sha256');
 function visit(item,slot='root') {
  if(item===null||typeof item!=='object'){
   const encoded=JSON.stringify(item);
   if(encoded!==undefined)hash.update(encoded);
   else if(slot==='object')hash.update('undefined');
   else if(slot==='root')hash.update(encoded); // same invalid root rejection
   return;
  }
  if(Array.isArray(item)){
   hash.update('[');for(let i=0;i<item.length;i++){if(i)hash.update(',');visit(item[i],'array');}hash.update(']');return;
  }
  hash.update('{');let first=true;
  for(const key of Object.keys(item).filter(key=>item[key]!==undefined).sort()){
   if(!first)hash.update(',');first=false;hash.update(JSON.stringify(key));hash.update(':');visit(item[key],'object');
  }
  hash.update('}');
 }
 visit(value);return hash.digest('hex');
}

/** Tiny immutable comparison proof; repository_meta intentionally resets its epoch. */
export function archiveRowHashes(archive) {
 const result={};
 for(const table of Object.keys(archive.tables).filter(table=>table!=='repository_meta').sort()){
  if(!Array.isArray(archive.tables[table]))throw new Error('Archive table must be an array: '+table);
  result[table]=Object.freeze(archive.tables[table].map(canonicalSha256).sort());
 }
 return Object.freeze(result);
}
export function assertArchiveRowHashes(archive,expected) {
 const keys=Object.keys(archive.tables).filter(table=>table!=='repository_meta').sort();
 if(keys.join(',')!==Object.keys(expected).sort().join(','))throw new Error('Migration changed business table set');
 for(const table of keys){
  const actual=archive.tables[table].map(canonicalSha256).sort(),before=expected[table];
  if(actual.length!==before.length||actual.some((hash,i)=>hash!==before[i]))throw new Error('Migration changed original business rows: '+table);
 }
}
