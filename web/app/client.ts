import { BoundedCache } from "../../server/shared/cache.mjs";
export const cache = new BoundedCache();
let runtime: Promise<string> | undefined;
export async function runtimeHeaders() {
  runtime ??= fetch("/api/v1/health", { cache: "no-store" }).then(async (r) => {
    if (!r.ok) throw Error("无法读取实例运行期");
    return (await r.json()).project.runtimeEpoch;
  });
  return { "x-review-runtime": await runtime };
}
const pending = new Map<string, Promise<any>>();
let cacheGeneration = 0;
export function invalidateReads() {
  cacheGeneration++;
  cache.clear();
  pending.clear();
}
export async function post(url: string, body: any) {
  const response = await fetch("/api/v1/" + url, {
      method: "POST",
      headers: {
        ...(await runtimeHeaders()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    value = await response.json();
  if (!response.ok || value.status === "FAILED")
    throw Object.assign(Error(value.error?.message || "操作失败"), {
      operationId: body.operationId,
      responseStatus: response.status,
    });
  return value;
}
export async function uploadMedia(file: File) {
  const operationId = crypto.randomUUID(),
    query = new URLSearchParams({
      operationId,
      mimeType: file.type || "application/octet-stream",
    });
  const response = await fetch("/api/v1/upload?" + query, {
      method: "POST",
      headers: {
        ...(await runtimeHeaders()),
        "Content-Type": "application/octet-stream",
      },
      body: file,
    }),
    receipt = await response.json();
  if (!response.ok)
    throw Object.assign(Error(receipt.error?.message || "上传失败"), {
      operationId,
    });
  for (;;) {
    const operation: any = await read("operations/" + operationId, {
      refresh: true,
    });
    if (operation.status === "SUCCEEDED")
      return {
        id: operation.result.mediaId,
        versionId: operation.result.versionId,
        sha256: operation.result.sha256,
        role: "OUTPUT",
      };
    if (["FAILED", "CANCELLED", "RESULT_UNKNOWN"].includes(operation.status))
      throw Object.assign(Error(operation.error?.message || operation.status), {
        operationId,
      });
    await new Promise((r) => setTimeout(r, 500));
  }
}
export async function read<T = any>(
  url: string,
  { refresh = false } = {},
): Promise<T> {
  await runtimeHeaders();
  if (!refresh) {
    const value = cache.get(url);
    if (value !== undefined) return value;
    if (pending.has(url)) return pending.get(url)!;
  }
  const generation = cacheGeneration;
  const request = fetch("/api/v1/" + url, { cache: "no-store" })
    .then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw Error(body.error?.message || "读取失败");
      if (generation === cacheGeneration && pending.get(url) === request)
        cache.set(url, body);
      return body;
    })
    .finally(() => {
      if (pending.get(url) === request) pending.delete(url);
    });
  pending.set(url, request);
  return request;
}
export async function commands(
  commands: unknown[],
  actor = { kind: "HUMAN", label: "网页用户" },
) {
  const operationId = crypto.randomUUID();
  try {
    const response = await fetch("/api/v1/transactions", {
      method: "POST",
      headers: {
        ...(await runtimeHeaders()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operationId, actor, commands }),
    });
    const receipt = await response.json();
    if (!response.ok)
      throw Object.assign(Error(receipt.error?.message || "操作失败"), {
        operationId,
        receipt,
      });
    invalidateReads();
    window.dispatchEvent(new Event("review:changed"));
    return receipt;
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { operationId });
    throw error;
  }
}
