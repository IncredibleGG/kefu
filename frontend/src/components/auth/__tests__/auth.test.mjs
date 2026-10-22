/**
 * 登入 / 原生 SSO 邏輯單元測試(由 run.mjs 打包後以 node:test 執行)。
 * 涵蓋:PKCE(與 Node crypto / 後端演算法一致)、deep link 解析、原生 SSO 流程(state 驗證、單次使用、
 * 逾時、錯誤碼)、多租戶回應解析。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// ---- 瀏覽器儲存替身(須在匯入受測模組前就緒) ----
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
globalThis.localStorage = memStorage();
globalThis.sessionStorage = memStorage();
globalThis.localStorage.setItem("kefu-server", "https://kf.example.com");

const { base64url, codeChallengeS256, createCodeVerifier, createPkcePair, createState, sha256Fallback } =
  await import("@/lib/pkce");
const { parseSetupLink, parseAuthCallback, NATIVE_REDIRECT_URI } = await import("@/components/auth/links");
const { beginNativeSso, buildSsoStartUrl, clearPendingSso, nativeSsoErrorText, readPendingSso, resolveNativeSsoCallback } =
  await import("@/components/auth/nativeSso");
const { normalizeTenantSlug, tenantChoicesOf } = await import("@/components/auth/loginApi");
const { opened } = await import("@/lib/platform");
const { ApiError, calls, setNext } = await import("@/api/client");

const s256 = (s) => createHash("sha256").update(s).digest("base64url");

/* ---------------------------------- PKCE ---------------------------------- */
test("pkce: verifier 為 64 字元 URL-safe 且不重複", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const v = createCodeVerifier();
    assert.match(v, /^[A-Za-z0-9_-]{64}$/);
    // 後端驗證規則 ^[A-Za-z0-9._~-]{43,128}$
    assert.match(v, /^[A-Za-z0-9._~-]{43,128}$/);
    seen.add(v);
  }
  assert.equal(seen.size, 200);
});

test("pkce: S256 challenge = base64url(sha256(verifier))", async () => {
  for (let i = 0; i < 20; i++) {
    const { verifier, challenge, method } = await createPkcePair();
    assert.equal(method, "S256");
    assert.equal(challenge, s256(verifier));
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  }
  assert.equal(await codeChallengeS256("abc"), s256("abc"));
});

test("pkce: 後備 SHA-256 與 Node crypto 一致(含區塊邊界長度)", () => {
  for (let n = 0; n < 200; n++) {
    const buf = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
    assert.equal(base64url(sha256Fallback(buf)), createHash("sha256").update(buf).digest("base64url"));
  }
});

test("pkce: state 為 43 字元 base64url", () => {
  assert.match(createState(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(createState(), createState());
});

/* -------------------------------- deep link -------------------------------- */
test("links: 佈建連結只回正規化的 https 伺服器", () => {
  assert.equal(parseSetupLink("kefu://setup?server=https%3A%2F%2Fexample.com%2Flogin"), "https://example.com");
  assert.equal(parseSetupLink("kefu:///setup?server=example.com"), "https://example.com");
  assert.equal(parseSetupLink("kefu://setup/?server=example.com"), "https://example.com");
  assert.equal(parseSetupLink("kefu://setup?server=http%3A%2F%2Fevil.com"), null);
  assert.equal(parseSetupLink("https://setup?server=example.com"), null);
  assert.equal(parseSetupLink("kefu://auth/callback?server=x.com"), null);
  assert.equal(parseSetupLink("kefu://setup"), null);
  assert.equal(parseSetupLink("not a url"), null);
});

test("links: SSO 回呼解析(含各平台的網址變體)", () => {
  assert.equal(NATIVE_REDIRECT_URI, "kefu://auth/callback");
  assert.deepEqual(parseAuthCallback("kefu://auth/callback?code=abc&state=s1"), { state: "s1", code: "abc" });
  assert.deepEqual(parseAuthCallback("kefu://auth/callback/?code=abc&state=s1"), { state: "s1", code: "abc" });
  assert.deepEqual(parseAuthCallback("kefu:///auth/callback?code=abc&state=s1"), { state: "s1", code: "abc" });
  assert.deepEqual(parseAuthCallback("kefu://auth/callback?sso_error=SSO_DISABLED&state=s1"), {
    state: "s1",
    ssoError: "SSO_DISABLED",
  });
  assert.equal(parseAuthCallback("kefu://auth/callback?code=abc"), null);
  assert.equal(parseAuthCallback("kefu://setup?code=abc&state=s"), null);
  assert.equal(parseAuthCallback("https://auth/callback?code=abc&state=s"), null);
});

/* -------------------------------- 原生 SSO -------------------------------- */
test("sso: 起點網址帶 PKCE 參數、不含 verifier", () => {
  const u = new URL(buildSsoStartUrl("saml", { state: "st", challenge: "ch", slug: "a/b" }));
  assert.equal(u.origin + u.pathname, "https://kf.example.com/api/v1/saml/login/a%2Fb");
  assert.equal(u.searchParams.get("client"), "native");
  assert.equal(u.searchParams.get("redirect_uri"), "kefu://auth/callback");
  assert.equal(u.searchParams.get("state"), "st");
  assert.equal(u.searchParams.get("code_challenge"), "ch");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
});

test("sso: Google 完整流程(偽造 state 不兌換、單次使用、重播忽略)", async () => {
  clearPendingSso();
  await beginNativeSso("google");
  const u = new URL(opened.at(-1));
  assert.equal(u.pathname, "/api/v1/auth/oauth/google/start");
  const p = readPendingSso();
  assert.ok(p);
  assert.equal(u.searchParams.get("state"), p.state);
  assert.equal(u.searchParams.get("code_challenge"), s256(p.verifier));
  assert.equal(u.toString().includes(p.verifier), false);

  const before = calls.length;
  const bad = await resolveNativeSsoCallback("kefu://auth/callback?code=x&state=evil", { state: "evil", code: "x" });
  assert.deepEqual(bad, { kind: "error", code: "SSO_STATE_MISMATCH", provider: "google" });
  assert.equal(calls.length, before, "state 不符不得兌換");
  assert.ok(readPendingSso(), "state 不符不得清掉進行中的流程");

  const url = `kefu://auth/callback?code=c123&state=${p.state}`;
  const ok = await resolveNativeSsoCallback(url, { state: p.state, code: "c123" });
  assert.equal(ok.kind, "ok");
  assert.deepEqual(calls.at(-1), {
    path: "/api/v1/auth/sso/exchange",
    opts: { method: "POST", body: { code: "c123", code_verifier: p.verifier }, auth: false },
  });
  assert.equal(readPendingSso(), null, "verifier 單次使用");
  assert.deepEqual(await resolveNativeSsoCallback(url, { state: p.state, code: "c123" }), { kind: "ignored" });
  const orphan = await resolveNativeSsoCallback("kefu://auth/callback?code=z&state=q", { state: "q", code: "z" });
  assert.deepEqual(orphan, { kind: "error", code: "SSO_EXPIRED" });
});

test("sso: sso_error、兌換失敗、逾時", async () => {
  await beginNativeSso("saml", "acme");
  assert.match(opened.at(-1), /\/api\/v1\/saml\/login\/acme\?/);
  let p = readPendingSso();
  const e = await resolveNativeSsoCallback(`kefu://auth/callback?sso_error=SSO_DISABLED&state=${p.state}`, {
    state: p.state,
    ssoError: "SSO_DISABLED",
  });
  assert.deepEqual(e, { kind: "error", code: "SSO_DISABLED", provider: "saml" });

  await beginNativeSso("google");
  p = readPendingSso();
  setNext(new ApiError("INVALID_CODE_VERIFIER", "x", 200));
  const r = await resolveNativeSsoCallback(`kefu://auth/callback?code=k&state=${p.state}`, { state: p.state, code: "k" });
  assert.deepEqual(r, { kind: "error", code: "INVALID_CODE_VERIFIER", provider: "google" });

  await beginNativeSso("google");
  const raw = JSON.parse(localStorage.getItem("kefu-sso-pending"));
  raw.at -= 6 * 60_000;
  localStorage.setItem("kefu-sso-pending", JSON.stringify(raw));
  assert.equal(readPendingSso(), null, "超過 5 分鐘即失效");
  assert.equal(localStorage.getItem("kefu-sso-pending"), null, "逾時即清除暫存");

  await assert.rejects(beginNativeSso("saml"), /slug/);
});

test("sso: App 在瀏覽器登入期間被系統回收(冷啟動)仍可完成兌換", async () => {
  setNext({ access_token: "tok", is_platform_admin: false });
  clearPendingSso();
  await beginNativeSso("google");
  const saved = localStorage.getItem("kefu-sso-pending");
  assert.ok(saved, "暫存寫入 localStorage");
  // 模擬程序被回收:記憶體暫存消失(clearPendingSso 也清掉儲存),再放回只有持久 localStorage 才留得住的紀錄
  clearPendingSso();
  localStorage.setItem("kefu-sso-pending", saved);
  const { state, verifier } = JSON.parse(saved);
  const r = await resolveNativeSsoCallback(`kefu://auth/callback?code=cold&state=${state}`, { state, code: "cold" });
  assert.equal(r.kind, "ok");
  assert.deepEqual(calls.at(-1).opts.body, { code: "cold", code_verifier: verifier });
  assert.equal(localStorage.getItem("kefu-sso-pending"), null, "verifier 單次使用");
});

test("sso: 錯誤碼對應友善文字", () => {
  const t = (_k, d) => (typeof d === "string" ? d : d?.defaultValue);
  assert.match(nativeSsoErrorText(t, "SSO_NOT_INVITED"), /邀請/);
  assert.match(nativeSsoErrorText(t, "SSO_DISABLED", "saml"), /SAML/);
  assert.match(nativeSsoErrorText(t, "SSO_DISABLED", "google"), /Google/);
  assert.match(nativeSsoErrorText(t, "SSO_EXPIRED"), /逾時/);
  assert.match(nativeSsoErrorText(t, "UNKNOWN_CODE", "saml"), /SAML/);
});

/* --------------------------------- 多租戶 --------------------------------- */
test("tenant: 解析租戶清單與 slug 正規化", () => {
  assert.deepEqual(
    tenantChoicesOf({
      requires_tenant_selection: true,
      tenants: [{ slug: "a", name: "" }, { slug: "", name: "x" }, null, { slug: "b", name: "B 公司" }],
    }),
    [
      { slug: "a", name: "a" },
      { slug: "b", name: "B 公司" },
    ],
  );
  assert.deepEqual(tenantChoicesOf({ access_token: "t" }), []);
  assert.equal(normalizeTenantSlug("  Acme "), "acme");
  assert.equal(normalizeTenantSlug(undefined), "");
});
