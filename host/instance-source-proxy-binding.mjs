import path from 'node:path';
import { canonicalJson } from './instance-runtime/index.mjs';
import { requireSource } from './instance-source-proof.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function alias(value) {
  requireSource(typeof value === 'string' && value && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.split('/').includes('..') && value !== '.', 'SOURCE_PROXY_BINDING_INVALID', 'Proxy bindings require normalized instance-relative aliases');
  return value;
}
function proxyAlias(value, kind, siteRoot) {
  requireSource(typeof value === 'string' && !/[?#%]/.test(value), 'SOURCE_PROXY_BINDING_INVALID', 'Proxy bindings require exact local URLs');
  if (kind === 'AUDIO') {
    requireSource(value.startsWith('/review-audio/') && value.length > '/review-audio/'.length, 'SOURCE_PROXY_BINDING_INVALID', 'Audio proxy binding requires its exact local route');
    return alias(`${siteRoot}/public/media/audio/${value.slice('/review-audio/'.length)}`);
  }
  requireSource(value.startsWith('/media/') && value.length > '/media/'.length, 'SOURCE_PROXY_BINDING_INVALID', 'Image proxy binding requires its exact local route');
  return alias(`${siteRoot}/public${value}`);
}
function collect(snapshot, siteRoot) {
  const pairs = new Map();
  const array = value => { requireSource(value === undefined || Array.isArray(value), 'SOURCE_PROXY_BINDING_INVALID', 'Published proxy projection must be an array'); return value || []; };
  function add(row, field, kind) {
    requireSource(row && typeof row === 'object' && !Array.isArray(row), 'SOURCE_PROXY_BINDING_INVALID', 'Proxy projection requires an object');
    // Expected outputs with no file/digest/preview are not cache bindings.
    if (row[field] == null && row.sha256 == null && row.outputState === 'NOT_PRODUCED') return;
    const sourcePath = alias(row.path);
    requireSource(digest(row.sha256), 'SOURCE_PROXY_BINDING_INVALID', 'Proxy projection requires its full source digest');
    const proxyPath = proxyAlias(row[field], kind, siteRoot);
    const binding = { sourcePath, sourceExpectedSha256: row.sha256, proxyPath };
    if (row.proxySha256 !== undefined) {
      requireSource(digest(row.proxySha256), 'SOURCE_PROXY_BINDING_INVALID', 'Proxy projection digest is invalid');
      binding.proxyExpectedSha256 = row.proxySha256;
    }
    const previous = pairs.get(proxyPath);
    requireSource(!previous || canonicalJson(previous) === canonicalJson(binding), 'SOURCE_PROXY_BINDING_AMBIGUOUS', 'One published proxy cannot claim different source bindings');
    pairs.set(proxyPath, binding);
  }
  for (const row of array(snapshot.visualAssets)) add(row, 'preview', 'VISUAL');
  for (const row of array(snapshot.audioAssets)) add(row, 'audio', 'AUDIO');
  for (const row of array(snapshot.p07?.storyboards)) add(row, 'reviewProxy', 'STORYBOARD');
  const contacts = snapshot.p07?.contactSheets;
  requireSource(contacts === undefined || (contacts && typeof contacts === 'object' && !Array.isArray(contacts)), 'SOURCE_PROXY_BINDING_INVALID', 'Contact proxy projection must be an object');
  for (const row of Object.values(contacts || {})) add(row, 'reviewProxy', 'CONTACT');
  return pairs;
}

/** SOURCE_SYNC only: an existing registered preview must retain its published source.
 * This verifies release-bound relationships, not historical conversion or media quality.
 * Fixed map names are protected separately by the original MAP_PROXY_SOURCES AST,
 * source/spec byte pins and the map adapter; these lists cover all other cache callers.
 */
export function assertSourceProxyBindingPreservation({ baseSnapshot, proposedSnapshot, pinnedMediaHashes, siteRoot = 'review-site' }) {
  alias(siteRoot);
  const baseline = collect(baseSnapshot, siteRoot);
  const proposed = collect(proposedSnapshot, siteRoot);
  const bindings = [];
  for (const [proxyPath, next] of proposed) {
    if (!Object.hasOwn(pinnedMediaHashes, proxyPath)) continue; // A new destination is built by the original compiler.
    const proxyPinnedSha256 = pinnedMediaHashes[proxyPath];
    requireSource(digest(proxyPinnedSha256), 'SOURCE_PROXY_BINDING_INVALID', 'A registered proxy requires its current byte digest');
    const previous = baseline.get(proxyPath);
    requireSource(previous, 'SOURCE_PROXY_BINDING_UNKNOWN', `Existing proxy lacks an exact published source relationship: ${proxyPath}`);
    requireSource(previous.sourcePath === next.sourcePath && previous.sourceExpectedSha256 === next.sourceExpectedSha256, 'SOURCE_PROXY_BINDING_CHANGED', `Source synchronization cannot reuse an existing proxy for a different source: ${proxyPath}`);
    for (const binding of [previous, next]) requireSource(!binding.proxyExpectedSha256 || binding.proxyExpectedSha256 === proxyPinnedSha256, 'SOURCE_PROXY_BINDING_CHANGED', `Registered proxy bytes differ from the release-bound projection: ${proxyPath}`);
    bindings.push({ sourcePath: next.sourcePath, sourceExpectedSha256: next.sourceExpectedSha256, proxyPath, proxyPinnedSha256 });
  }
  return { mode: 'RELEASE_BOUND_EXISTING_PROXY_RELATIONSHIPS', bindings: bindings.sort((left, right) => left.proxyPath.localeCompare(right.proxyPath)) };
}
