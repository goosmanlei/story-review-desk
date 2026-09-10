const BASE_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

export function normalizeBasePath(value = '') {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  const normalized = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (!BASE_PATH_PATTERN.test(normalized) || normalized.includes('//')) {
    throw new Error('REVIEW_BASE_PATH must be empty or an absolute URL path without a trailing slash');
  }
  return normalized;
}

export function configuredBasePath() {
  return normalizeBasePath(process.env.REVIEW_BASE_PATH || '');
}

export function deploymentMode() {
  if (process.env.REVIEW_REMOTE_READ_ONLY === '1') return 'SITES_READ_ONLY';
  return process.env.REVIEW_DEPLOYMENT_MODE === 'VPS' ? 'VPS' : 'LOCAL';
}

export function publicHttpPath(value) {
  if (typeof value !== 'string') return value;
  const basePath = configuredBasePath();
  if (!basePath || !value.startsWith('/') || value.startsWith('//') || value === basePath || value.startsWith(basePath + '/')) return value;
  return basePath + value;
}

function configuredPublicUrl() {
  const raw = process.env.REVIEW_PUBLIC_URL || process.env.SITE_BASE_URL || '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('VPS mode requires REVIEW_PUBLIC_URL'); }
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:') throw new Error('REVIEW_PUBLIC_URL must be one HTTPS URL without credentials, query, or fragment');
  const basePath = configuredBasePath();
  const pathname = url.pathname.replace(/\/$/, '') || '';
  if (pathname !== basePath) throw new Error('REVIEW_PUBLIC_URL pathname must equal REVIEW_BASE_PATH');
  return url;
}

export function trustedRequestIdentity(request) {
  if (deploymentMode() !== 'VPS') return { mode: deploymentMode(), origin: new URL(request.url).origin, authenticatedUser: null };
  const expected = configuredPublicUrl();
  // Only the socket-checking gateway may supply this per-process secret. The
  // application listens on loopback behind it, never on the ingress network.
  const secret = process.env.REVIEW_INTERNAL_GATEWAY_SECRET;
  if (!secret || request.headers.get('x-review-internal-gateway') !== secret) throw new Error('Untrusted gateway connection');
  const marker = request.headers.get('x-review-proxy');
  const user = request.headers.get('x-review-authenticated-user') || '';
  const forwardedHost = request.headers.get('x-forwarded-host') || '';
  const forwardedProto = request.headers.get('x-forwarded-proto') || '';
  const forwardedPort = request.headers.get('x-forwarded-port') || '';
  if (marker !== 'controlled-nginx-v1') throw new Error('VPS request did not pass through the controlled Nginx entry');
  const accessMode=process.env.REVIEW_VPS_ACCESS_MODE||'BASIC_AUTH';
  const claimedMode=request.headers.get('x-review-access-mode');
  if(accessMode==='PUBLIC_DEMO'){
    if(claimedMode!=='PUBLIC_DEMO'||user)throw new Error('Public demo proxy identity differs');
  }else if(accessMode!=='BASIC_AUTH'||claimedMode&&claimedMode!=='BASIC_AUTH'||!/^[^\u0000-\u001f\u007f]{1,200}$/.test(user))throw new Error('VPS request lacks an authenticated Basic Auth identity');
  if (forwardedProto !== 'https' || forwardedHost !== expected.host || forwardedPort !== (expected.port||'443')) throw new Error('VPS forwarded origin differs from the configured public URL');
  return { mode: 'VPS', origin: expected.origin, authenticatedUser: user||null };
}

export function sameDeploymentOrigin(request, allowedOrigins) {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return false;
  try {
    const identity = trustedRequestIdentity(request);
    const browserOrigin = new URL(origin).origin;
    if (origin !== browserOrigin) return false;
    return browserOrigin === identity.origin && allowedOrigins.has(browserOrigin);
  } catch {
    return false;
  }
}

export function assertBrowserRuntimeBinding(request, runtimeEpoch) {
  if (deploymentMode() !== 'VPS') return;
  trustedRequestIdentity(request);
  const deploymentId = String(process.env.REVIEW_DEPLOYMENT_ID || '');
  if (!ID_PATTERN.test(deploymentId)) throw new Error('VPS mode requires a valid REVIEW_DEPLOYMENT_ID');
  if (request.headers.get('x-review-deployment-id') !== deploymentId || request.headers.get('x-review-runtime-epoch') !== runtimeEpoch) {
    throw new Error('Browser deployment changed; reload before writing');
  }
}

export function deploymentPublicFacts(runtimeEpoch = null) {
  const mode = deploymentMode();
  const deploymentId = mode === 'VPS' ? String(process.env.REVIEW_DEPLOYMENT_ID || '') : `local:${process.env.REVIEW_SOFTWARE_COMMIT || 'UNKNOWN'}`;
  if (mode === 'VPS' && !ID_PATTERN.test(deploymentId)) throw new Error('VPS mode requires a valid REVIEW_DEPLOYMENT_ID');
  return Object.freeze({ mode, deploymentId, runtimeEpoch, basePath: configuredBasePath() });
}
