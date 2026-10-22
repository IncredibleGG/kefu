/** ============================================================
 *  PKCE(RFC 7636)工具:原生 SSO 用(docs/NATIVE-CLIENTS.md §4.1)。
 *  - code_verifier:64 字元 URL-safe 隨機字串(RFC 7636 unreserved 字元的子集 [A-Za-z0-9-_],
 *    符合後端 ^[A-Za-z0-9._~-]{43,128}$)。
 *  - code_challenge:base64url(SHA-256(verifier)),method 固定 S256。
 *  - state:32 bytes 隨機 → base64url(43 字元),回呼時比對防 login CSRF。
 *  隨機數一律取 crypto.getRandomValues(CSPRNG);不可用時直接丟錯,**絕不**退回 Math.random。
 *  SHA-256 優先用 crypto.subtle;少數原生 WebView 非 secure context 時 subtle 不存在,改用內建純 JS 實作
 *  (結果相同,僅供計算公開的 challenge,不涉及金鑰)。
 *  本檔不依賴任何專案模組(可直接以 node 測試)。
 *  ============================================================ */

/** 錯誤:執行環境沒有安全亂數來源。 */
export class PkceUnavailableError extends Error {
  constructor() {
    super("secure random unavailable");
    this.name = "PkceUnavailableError";
  }
}

const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== "function") throw new PkceUnavailableError();
  const b = new Uint8Array(n);
  c.getRandomValues(b);
  return b;
}

/** base64url(無 padding)。 */
export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** URL-safe 隨機字串(64 個字元 → 每字元 6 bit 剛好整除 256,無取模偏差)。 */
export function randomUrlSafe(length = 64): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += URL_SAFE[bytes[i] & 63];
  return out;
}

/** 產生 code_verifier(預設 64 字元;RFC 允許 43–128)。 */
export function createCodeVerifier(length = 64): string {
  const n = Math.min(128, Math.max(43, Math.floor(length)));
  return randomUrlSafe(n);
}

/** 產生隨機 state(32 bytes → base64url 43 字元)。 */
export function createState(): string {
  return base64url(randomBytes(32));
}

/* ---------------------------- SHA-256(後備實作) ---------------------------- */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 純 JS SHA-256(僅在 crypto.subtle 不可用時使用)。 */
export function sha256Fallback(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle && typeof subtle.digest === "function") {
    try {
      return new Uint8Array(await subtle.digest("SHA-256", data as BufferSource));
    } catch {
      /* 非 secure context 等:落到後備實作 */
    }
  }
  return sha256Fallback(data);
}

/** S256 code_challenge = base64url(SHA-256(ASCII(verifier)))。 */
export async function codeChallengeS256(verifier: string): Promise<string> {
  return base64url(await sha256(new TextEncoder().encode(verifier)));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** 一次產生 verifier + challenge。 */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = createCodeVerifier(64);
  return { verifier, challenge: await codeChallengeS256(verifier), method: "S256" };
}
