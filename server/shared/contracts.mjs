import { createHash, randomUUID } from "node:crypto";

export class ReviewError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
export function check(
  condition,
  code,
  message,
  status = 400,
  details = undefined,
) {
  if (!condition) throw new ReviewError(code, message, status, details);
}
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
      .join(",") +
    "}"
  );
}
export const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : canonical(value),
    )
    .digest("hex");
export const identifier = (prefix = "rev") => prefix + "_" + randomUUID();
export function identity(value, name = "id") {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 1024 &&
      !/[\u0000-\u001f]/.test(value),
    "INVALID_ID",
    `${name} 无效`,
  );
  return value;
}
export function objectValue(value, name = "content") {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "INVALID_CONTENT",
    `${name} 必须是对象`,
  );
  check(
    Buffer.byteLength(canonical(value)) <= 8 * 1024 * 1024,
    "CONTENT_TOO_LARGE",
    "单对象内容不能超过 8 MiB；长来源须分块读取",
    413,
  );
  return value;
}
export function expectedVersion(value) {
  check(
    Number.isSafeInteger(value) && value >= 0,
    "EXPECTED_VERSION_REQUIRED",
    "请携带对象的 expectedVersion",
  );
  return value;
}
export const errorBody = (error) => ({
  error: {
    code: error.code || "INTERNAL_ERROR",
    message:
      error instanceof ReviewError
        ? error.message
        : "操作失败，请使用操作编号查询结果",
    ...(error.details ? { details: error.details } : {}),
  },
});
