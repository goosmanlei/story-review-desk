import { instanceProfile } from '../../../instance-profile';
import { hostedReadOnlyMode, HttpError, sameOrigin, reviewData, validateBrowserDeployment } from '../../v8/_store';
import {deploymentMode,trustedRequestIdentity} from '../../../../host/instance-runtime/deployment-http.mjs';

export function assertAssistantLocal(request: Request) {
  if (hostedReadOnlyMode()) throw new HttpError(405, '远端镜像只读，请在本地审阅台使用助手。');
  if(deploymentMode()==='VPS'){
    try{trustedRequestIdentity(request);}catch(error){throw new HttpError(403,error instanceof Error?error.message:'远端助手入口不可信。');}
    const fetchSite=request.headers.get('sec-fetch-site');if(fetchSite&&fetchSite!=='same-origin'&&fetchSite!=='none')throw new HttpError(403,'不接受跨站助手请求。');
    if(request.method!=='GET'&&!sameOrigin(request))throw new HttpError(403,'助手请求来源不匹配。');
    return;
  }
  const target = new URL(request.url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new HttpError(403, '助手仅接受本机请求。');
  const origins = process.env.REVIEW_ALLOWED_ORIGINS || process.env.SITE_BASE_URL || 'http://localhost:3000,http://127.0.0.1:3000';
  const allowedPorts = origins.split(',').flatMap((origin) => {
    try { const url = new URL(origin.trim()); return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? [url.port || (url.protocol === 'https:' ? '443' : '80')] : []; } catch { return []; }
  });
  if (!allowedPorts.includes(target.port || (target.protocol === 'https:' ? '443' : '80'))) throw new HttpError(403, '助手请求端口不在本机配置中。');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw new HttpError(403, '不接受跨站助手请求。');
  if (request.method !== 'GET' && !sameOrigin(request)) throw new HttpError(403, '助手请求来源不匹配。');
}

export async function assistantBody(request: Request, fields: string[]) {
  assertAssistantLocal(request);
  await validateBrowserDeployment(request);
  if(instanceProfile(await reviewData()).capabilities.assistantEnabled===false)throw new HttpError(403,'本实例已关闭 Codex 辅助入口。');
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, '请求必须为JSON。');
  if (Number(request.headers.get('content-length') || 0) > 100_000) throw new HttpError(413, '本轮文字超过大小限制。');
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 100_000) throw new HttpError(413, '本轮文字超过大小限制。');
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { throw new HttpError(400, '请求JSON无效。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new HttpError(400, '请求包含不支持的字段。');
  return value;
}

export function assistantIdempotencyKey(request: Request) {
  const key = request.headers.get('idempotency-key') || '';
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) throw new HttpError(400, '本轮缺少有效的请求编号。');
  return key;
}
