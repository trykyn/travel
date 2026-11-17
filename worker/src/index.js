// 여행 앱 ↔ 노션 연결 서버 (Cloudflare Worker, 무료 요금제)
//
// POST /notion  { calls: [{ method, path, body }] }   (한 번에 최대 25개, 차례로 실행)
//   Authorization: Bearer <Firebase ID 토큰>
//   → { results: [{ status, data }] }
// POST /ping    → { ok: true }   (연결 확인)
//
// 노션 공식 API는 브라우저에서 바로 부를 수 없고(CORS), 노션 비밀 키를 앱에 넣으면 누구나 노션을 고칠 수 있음.
// 그래서 이 서버가 비밀 키를 숨겨 두고, 이 가족(가족 코드)에 속한 사람의 요청만 노션에 넘겨 줌.
// 노션 쪽 권한도 '여행 앱' 통합이 연결된 페이지(여행)와 그 아래로만 제한됨.
//
// Notion's API can't be called from a browser, and the integration secret must not ship in the public app.
// This worker keeps the secret and forwards only requests from people in this family (Firestore users/{uid}.house
// must equal the HOUSE secret). Only page / block / database / search endpoints are allowed.
//
// 비밀 값 (코드에 적지 않음):
//   npx.cmd wrangler secret put NOTION_TOKEN   ← 노션 '여행 앱' 통합의 내부 통합 시크릿
//   npx.cmd wrangler secret put HOUSE          ← 앱 설정에 보이는 가족 코드

const FIREBASE_PROJECT = "shopping-list-ae06d";
const ALLOWED_ORIGINS = ["https://trykyn.github.io", "http://localhost:8773"];
const NOTION = "https://api.notion.com/v1/";
const NOTION_VERSION = "2022-06-28";
const MAX_CALLS = 25;
const ID = "[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Erlaubte Notion-Pfade / 허용하는 노션 주소
const PATHS = [
  new RegExp(`^pages$`), new RegExp(`^pages/(${ID})$`),
  new RegExp(`^blocks/(${ID})$`), new RegExp(`^blocks/(${ID})/children$`),
  new RegExp(`^databases$`), new RegExp(`^databases/(${ID})$`), new RegExp(`^databases/(${ID})/query$`),
  new RegExp(`^search$`),
];
const METHODS = ["GET", "POST", "PATCH", "DELETE"];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/notion" && path !== "/ping")) return json({ error: "not_found" }, 404);
    if (!env.NOTION_TOKEN || !env.HOUSE) return json({ error: "not_configured" }, 503);

    try {
      const me = await whoAmI((request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""));
      if (me.house !== env.HOUSE) return json({ error: "other_family" }, 403);
    } catch (e) {
      return json({ error: e.message === "no_house" ? "no_house" : "unauthorized" }, e.message === "no_house" ? 409 : 401);
    }
    if (path === "/ping") return json({ ok: true });

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
    const calls = Array.isArray(body && body.calls) ? body.calls.slice(0, MAX_CALLS) : [];
    // Notion-Antworten ungelesen durchreichen (Gratis-Tarif: wenig Rechenzeit pro Anfrage)
    // 노션 응답은 해석하지 않고 그대로 넘김 (무료 요금제는 요청마다 계산 시간이 아주 짧음)
    const parts = [];
    for (const c of calls) { const r = await forward(c, env); parts.push(`{"status":${r.status},"data":${r.raw || "null"}}`); }
    return new Response(`{"results":[${parts.join(",")}]}`, { headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
  },
};

async function forward(c, env) {
  const method = String((c && c.method) || "GET").toUpperCase();
  const [p, query = ""] = String((c && c.path) || "").replace(/^\/+/, "").split("?");
  if (!METHODS.includes(method) || !PATHS.some((re) => re.test(p)) || !/^[\w=&%.-]*$/.test(query)) return { status: 400, raw: '{"error":"path_not_allowed"}' };
  const init = {
    method,
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
  };
  if (c.body != null && method !== "GET") init.body = JSON.stringify(c.body);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(NOTION + p + (query ? "?" + query : ""), init);
    // Notion erlaubt etwa 3 Anfragen pro Sekunde / 노션은 초당 약 3번까지
    if (r.status === 429 && attempt < 2) {
      await new Promise((ok) => setTimeout(ok, Math.min(3000, 1000 * Number(r.headers.get("Retry-After") || 1))));
      continue;
    }
    const raw = (await r.text()).trim();
    // Nur JSON-Objekte weitergeben / JSON 객체만 넘김
    return { status: r.status, raw: raw.startsWith("{") && raw.endsWith("}") ? raw : null };
  }
  return { status: 429, raw: '{"error":"rate_limited"}' };
}

/* ---------- Firebase sign-in check (wie our-family) / 로그인 확인 ---------- */

let keyCache = { keys: null, until: 0 };
async function googleKeys() {
  if (keyCache.keys && Date.now() < keyCache.until) return keyCache.keys;
  const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  const { keys } = await r.json();
  const maxAge = Number(((r.headers.get("Cache-Control") || "").match(/max-age=(\d+)/) || [])[1] || 3600);
  keyCache = { keys, until: Date.now() + maxAge * 1000 };
  return keys;
}
const importedKeys = new Map();
const b64url = (s) => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
async function verifyFirebaseToken(token) {
  const [h, p, sig] = String(token).split(".");
  if (!h || !p || !sig) throw new Error("malformed");
  const dec = new TextDecoder();
  const header = JSON.parse(dec.decode(b64url(h)));
  const payload = JSON.parse(dec.decode(b64url(p)));
  if (header.alg !== "RS256") throw new Error("alg");
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("kid");
  let key = importedKeys.get(jwk.kid);
  if (!key) {
    key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    importedKeys.set(jwk.kid, key);
  }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error("signature");
  const now = Date.now() / 1000;
  if (payload.aud !== FIREBASE_PROJECT || payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT}`) throw new Error("audience");
  if (!payload.sub || payload.exp < now - 60 || payload.iat > now + 300) throw new Error("expired");
  return payload;
}
// Firestore-Regeln: nur das eigene users-Dokument ist lesbar → der Familiencode dieser Person
// Firestore 규칙상 자기 users 문서만 읽을 수 있음 → 그 사람이 속한 가족 코드
const houseCache = new Map();
async function whoAmI(idToken) {
  const user = await verifyFirebaseToken(idToken);
  const cached = houseCache.get(user.sub);
  if (cached && cached.until > Date.now()) return { uid: user.sub, house: cached.house };
  const r = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/users/${encodeURIComponent(user.sub)}`,
    { headers: { Authorization: `Bearer ${idToken}` } });
  const doc = r.ok ? await r.json() : null;
  const house = doc && doc.fields && doc.fields.house && doc.fields.house.stringValue;
  if (!house) throw new Error("no_house");
  houseCache.set(user.sub, { house, until: Date.now() + 10 * 60 * 1000 });
  return { uid: user.sub, house };
}
