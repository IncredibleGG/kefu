// 測試替身:@/api/client(記錄 apiFetch 呼叫,回傳可設定的結果)
export class ApiError extends Error {
  constructor(code, message, httpStatus = 0) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
export const calls = [];
let next = { access_token: "tok", is_platform_admin: false };
export function setNext(v) {
  next = v;
}
export async function apiFetch(path, opts) {
  calls.push({ path, opts });
  if (next instanceof Error) throw next;
  return next;
}
