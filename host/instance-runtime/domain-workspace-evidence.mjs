import {canonicalJson,sha256} from './bytes.mjs';
import {domainCollections} from './domain-ownership.mjs';
import {verifySourceBindings} from './domain-sources.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};

/** previousGraph must come from the release-bound graph read in this transaction,
 * never from a workspace draft. Permission to retain evidence belongs to its
 * original collection and permanent row, not to the source binding globally. */
export async function verifyDomainWorkspaceEvidence(tx,graph,previousGraph) {
  const currentBindings=new Map(),documents=new Map();
  for(const collection of domainCollections) {
    const previousRows=new Map(previousGraph[collection].map(row=>[row.id,row]));
    for(const row of graph[collection]) {
      const retained=new Map();
      for(const evidence of previousRows.get(row.id)?.evidence||[]) {
        const key=canonicalJson(evidence);
        retained.set(key,(retained.get(key)||0)+1);
      }
      for(const evidence of row.evidence||[]) {
        const key=canonicalJson(evidence),remaining=retained.get(key)||0;
        if(!remaining) {
          const binding={sourceId:evidence.sourceId,revisionId:evidence.revisionId,sha256:evidence.sha256};
          currentBindings.set(canonicalJson(binding),binding);
          continue;
        }
        retained.set(key,remaining-1);
        if(!documents.has(evidence.revisionId))documents.set(evidence.revisionId,await tx.readDocumentRevision(evidence.revisionId));
        const document=documents.get(evidence.revisionId);
        if(!document||document.deleted||document.revisionId!==evidence.revisionId||document.sha256!==evidence.sha256||!document.bytes||sha256(document.bytes)!==evidence.sha256)
          fail(`历史来源无法精确回读或 SHA 不一致：${collection}:${row.id}`);
        if(evidence.quote&&!Buffer.from(document.bytes).toString('utf8').includes(evidence.quote))
          fail(`历史来源引用无法精确回读：${collection}:${row.id}`);
      }
    }
  }
  // Even if the same source was retained elsewhere, every added or changed
  // occurrence still needs the normal current-source authorization.
  await verifySourceBindings(tx,[...currentBindings.values()],{allowLegacy:true});
  return true;
}
