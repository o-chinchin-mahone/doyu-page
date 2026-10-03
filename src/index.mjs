// Lambda Function URL（ペイロード v2.0）のハンドラ
//   ルーティング / CORS / IP制限 だけを持ち、中身は tags.mjs に置く
//   設計: docs/04 §7（APIの方針）、docs/01 §2.1（noindex）、docs/09 M1
import { readFileSync } from "node:fs";
import { BlockList, isIPv6 } from "node:net";
import { timingSafeEqual } from "node:crypto";
import * as tags from "./tags.mjs";
import { ApiError } from "./tags.mjs";
import { issueToken, verifyToken, newAnon, signCursor, verifyCursor } from "./token.mjs";

const STAGE = process.env.STAGE ?? "local";
const EXTENSION_ID = process.env.EXTENSION_ID ?? "";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "";
// Cloudflare の Worker と共有する合言葉（docs/09 M5）。
// 設定されている間は、Function URL への直撃を 403 で落とす。
// 未設定なら素通し（Worker を置く前でも動く）
const ORIGIN_SECRET = process.env.ORIGIN_SECRET ?? "";
// 公開性検証は外部へのHTTPアクセスを伴うので、ローカル確認では切れるようにしておく
const VERIFY_PUBLIC = (process.env.VERIFY_PUBLIC ?? "1") !== "0";

const PAGE = readFileSync(new URL("./page.html", import.meta.url), "utf8");
// ページが読み込むスクリプト。インラインに書かない（CSP を script-src 'self' に保つため）
const ASSETS = Object.fromEntries(
  [["page", "./page.js"], ["source", "./legal/source.js"], ["takedown", "./legal/takedown.js"]].map(([name, file]) => [
    `/assets/${name}.js`, readFileSync(new URL(file, import.meta.url), "utf8"),
  ]),
);

// ★ zip には src/ しか入らないので、デプロイ時に LICENSE は zip の直下に置かれる（deploy.mjs）。
//   手元では src/ の1つ上にある。どちらでも読めるようにする
//   （これを取り違えると Lambda がモジュール読み込みの時点で落ちる）
const readFirst = (...urls) => {
  for (const url of urls) {
    try { return readFileSync(url, "utf8"); } catch { /* 次を試す */ }
  }
  return "";
};
// 法務ページ（docs/09 M4a）。Web面は M6a なので、それまでは Lambda が直接返す
//   利用規約などの文面は運営者ごとのもので、公開用のリポジトリには入っていない。
//   無いときは置き場所を示すだけのページを返す（自分で動かす人が src/legal/ に置く）
const LEGAL = Object.fromEntries(
  ["terms", "privacy", "takedown", "transmission", "source"].map((name) => [
    name, readFirst(new URL(`./legal/${name}.html`, import.meta.url))
      || `<h1>未設定</h1><p>運営者が <code>src/legal/${name}.html</code> に文面を置きます。</p>`,
  ]),
);
const LICENSE = readFirst(new URL("./LICENSE", import.meta.url), new URL("../LICENSE", import.meta.url));
const SOURCE_URL = process.env.SOURCE_URL ?? "https://github.com/o-chinchin-mahone/doyu-page";
const VERSION = process.env.VERSION ?? "dev";
// ★ Web面にも「サーバーと同じ正規化の解釈器」をそのまま配る。
//   実装を2つ持つと1文字ズレただけでハッシュが一致せず、タグが1件も出ない（docs/04 §9）
const NORMALIZER = readFileSync(new URL("./normalize.mjs", import.meta.url), "utf8");

// ALLOWED_IPS: "1.2.3.4/32,2400:xxxx::/64"。未設定なら全員許可
const allowed = (process.env.ALLOWED_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const allowList = new BlockList();
for (const cidr of allowed) {
  const [addr, prefix] = cidr.split("/");
  const type = isIPv6(addr) ? "ipv6" : "ipv4";
  allowList.addSubnet(addr, Number(prefix ?? (type === "ipv6" ? 128 : 32)), type);
}
const ipAllowed = (ip) => !allowed.length || (!!ip && allowList.check(ip, isIPv6(ip) ? "ipv6" : "ipv4"));

// 合言葉は定数時間で比べる（=== は先頭一致の分だけ早く返り、総当たりの手掛かりになる）
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const allowedOrigins = new Set([
  ...(EXTENSION_ID ? [`chrome-extension://${EXTENSION_ID}`] : []),
  ...(WEB_ORIGIN ? [WEB_ORIGIN] : []),
]);

function corsHeaders(origin) {
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-doyu-token",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    // タグ検索ページは検索エンジンに載せない（docs/01 §2.1）
    "x-robots-tag": "noindex, nofollow",
    "cache-control": "no-store",
    ...extra,
  },
  body: JSON.stringify(body),
});

const html = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
    // スクリプトも通信先も自分のオリジンだけ。どこかで innerHTML を使ってしまっても外へ送れない
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    ...extra,
  },
  body,
});

// 法務ページの外枠。4本のリンクをどのページからも辿れるようにする
const legalPage = (name) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>どゆページ</title>
<style>
  :root { color-scheme: light dark; --line:#dcdcdc; --muted:#666; --accent:#1a6b5a; --soft:#f6f6f4; }
  @media (prefers-color-scheme: dark) { :root { --line:#333; --muted:#999; --accent:#6fd1b8; --soft:#1b1b1b; } }
  body { font:15px/1.9 system-ui,"Hiragino Kaku Gothic ProN",Meiryo,sans-serif; margin:0 auto; padding:24px 18px 80px; max-width:760px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:32px 0 8px; border-bottom:1px solid var(--line); padding-bottom:4px; }
  h3 { font-size:14px; margin:20px 0 6px; color:var(--muted); }
  .meta,.note { color:var(--muted); font-size:13px; } .note { display:block; }
  .lead { background:var(--soft); padding:12px 14px; border-radius:8px; }
  table { border-collapse:collapse; width:100%; margin:10px 0; font-size:14px; }
  th,td { border:1px solid var(--line); padding:6px 9px; text-align:left; vertical-align:top; }
  th { background:var(--soft); font-weight:600; white-space:nowrap; }
  code { background:var(--soft); padding:1px 5px; border-radius:4px; font-size:12px; }
  a { color:var(--accent); }
  nav { border-bottom:1px solid var(--line); padding-bottom:10px; margin-bottom:22px; font-size:13px; display:flex; gap:14px; flex-wrap:wrap; }
  nav .bar { display:inline-block; width:3px; height:14px; background:var(--accent); border-radius:2px; vertical-align:-2px; margin-right:6px; }
  footer { margin-top:48px; border-top:1px solid var(--line); padding-top:12px; font-size:12px; color:var(--muted); }
  .button { display:inline-block; border:1px solid var(--accent); color:var(--accent); border-radius:6px; padding:6px 14px; text-decoration:none; background:none; font:inherit; cursor:pointer; }
  .report { background:var(--soft); padding:12px 14px; border-radius:8px; }
  .report label { display:block; margin:10px 0; font-size:14px; }
  .report input, .report select, .report textarea { display:block; width:100%; box-sizing:border-box; margin-top:4px; padding:6px 8px; font:inherit; border:1px solid var(--line); border-radius:6px; }
  ol li, ul li { margin:4px 0; }
</style></head><body>
<nav><span><span class="bar"></span><strong>どゆページ</strong></span>
<a href="/terms">利用規約</a><a href="/privacy">プライバシーポリシー</a><a href="/takedown">削除の申出</a><a href="/transmission">外部送信について</a><a href="/source">ソースコード</a></nav>
${LEGAL[name]}
<footer>どゆページ ／ お問い合わせ: abuse@doyu.page ／ <a href="/source">ソースコード</a></footer>
</body></html>`;

const parseBody = (event) => {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try { return JSON.parse(raw); } catch { throw new ApiError(400, "bad_json"); }
};

const query = (event) => Object.fromEntries(new URLSearchParams(event.rawQueryString ?? ""));

// トークンから anon を取り出す。★ クライアントが自称する anon は信用しない（99 §3 D2）
const anonOf = (event, body) => {
  const token = event.headers?.["x-doyu-token"] ?? body.token;
  if (!token) throw new ApiError(401, "token_required");
  try { return verifyToken(token); } catch (e) { throw new ApiError(401, e.code ?? "token_invalid"); }
};

async function route(event, { method, path, ip, cors }) {
  // --- 設定の配信（キャッシュ可） ---
  if (method === "GET" && path === "/v1/params") {
    return json(200, await tags.getParams(), { ...cors, "cache-control": "public, max-age=60" });
  }
  if (method === "GET" && path === "/v1/norm-rules") {
    // 正規表現は配信しない（ReDoS・リモートコード禁止。05 §7.4）。解釈器は拡張に同梱する
    return json(200, tags.RULES, { ...cors, "cache-control": "public, max-age=3600" });
  }

  // --- 匿名IDの発行（名乗りの偽装だけを防ぐ） ---
  if (method === "POST" && path === "/v1/hello") {
    const body = parseBody(event);
    // 期限切れ・壊れたトークンは黙って新しいIDを配る（クライアントを詰まらせない）
    let anon;
    try { anon = body.token ? verifyToken(body.token) : newAnon(); }
    catch { anon = newAnon(); }
    return json(200, { anon, token: issueToken(anon) }, cors);
  }

  // --- 読み取り（無認証・無Cookie・IPを見ない。04 §7） ---
  if (method === "GET" && path === "/v1/tags") {
    // フルURLは受け取らず、ハッシュで引く（鍵の考え方は store.mjs の urlPk）。
    //   サーバーが知るのは「既にタグが付いているページかどうか」だけ
    const { hash } = query(event);
    const rows = await tags.readTagsOfUrl(hash);
    return json(200, { hash, items: rows }, { ...cors, "cache-control": "public, max-age=60" });
  }

  // --- 書き込み: タグを付ける ---
  if (method === "POST" && path === "/v1/tags") {
    const body = parseBody(event);
    const anon = anonOf(event, body);
    const result = await tags.postTag({
      url: body.url,
      tag: body.tag,
      title: body.title ?? null, // 見ている本人のブラウザが持っている document.title
      anon,
      ip, // ★ 投稿ログ（発信者情報）にだけ使う。読み取り経路では触らない
      ua: event.headers?.["user-agent"] ?? null,
      event_id: body.event_id ?? null,
      ...(VERIFY_PUBLIC ? {} : { verify: null }),
    });
    return json(200, result, cors);
  }

  // --- 取り消し（自分が今付けたものだけ。docs/05 §4.2） ---
  if (method === "POST" && path === "/v1/tags/undo") {
    const body = parseBody(event);
    const anon = anonOf(event, body);
    return json(200, await tags.undoTag({ url: body.url, tag: body.tag, anon }), cors);
  }

  // --- ドメイン内検索 ---
  if (method === "GET" && path === "/v1/search") {
    const q = query(event);
    let cursor = null;
    try { cursor = verifyCursor(q.cursor); } catch { throw new ApiError(400, "cursor_invalid"); }
    const r = await tags.search({ domain: q.domain, tag: q.tag, cursor, limit: Number(q.limit) || 20, order: q.order ?? "newest" });
    return json(200, { ...r, cursor: signCursor(r.cursor) }, { ...cors, "cache-control": "public, max-age=60" });
  }

  // --- 到達（検索結果 → 目的ページ。docs/02 §3）。表示寿命を延ばす唯一の入力 ---
  if (method === "POST" && path === "/v1/reach") {
    const body = parseBody(event);
    // 無認証。連打は tags.mjs の LIMITS.reachIntervalSec で数えない（誰が送ったかは見ない）
    return json(200, await tags.recordReach({ url_hash: body.url_hash, tag_id: body.tag_id }), cors);
  }

  // --- KPI 日次集計（URLを含まない） ---
  if (method === "POST" && path === "/v1/kpi") {
    const body = parseBody(event);
    const anon = anonOf(event, body);
    const { date, domain, shown, with_tags } = body;
    return json(200, await tags.recordKpi({ date, domain, shown, with_tags, anon }), cors);
  }

  return json(404, { error: "not_found" }, cors);
}

/**
 * 発信者のIP（docs/07 §3.1 の発信者情報）。
 * Worker を通っているときは、本当のクライアントIPはヘッダで渡ってくる。
 * ★信用するのは合言葉が合っているときだけ。そうでないと誰でも他人のIPを名乗れる
 */
export const clientIp = (event, trusted) => {
  const forwarded = event.headers?.["x-doyu-client-ip"];
  return (trusted && forwarded) ? forwarded : event.requestContext.http.sourceIp;
};

export async function handler(event) {
  const { method } = event.requestContext.http;
  const path = event.rawPath;

  // 前段（Worker）を通っていないリクエストを落とす。Function URL の直撃を塞ぐ
  const fromWorker = !ORIGIN_SECRET || safeEqual(event.headers?.["x-doyu-origin"] ?? "", ORIGIN_SECRET);
  if (!fromWorker) {
    return { statusCode: 403, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Forbidden" };
  }
  const ip = clientIp(event, fromWorker && Boolean(ORIGIN_SECRET));
  const origin = event.headers?.origin;
  const cors = corsHeaders(origin);

  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  // 自分のIP確認用（IP制限の外でも使える）
  if (path === "/api/whoami") return json(200, { ip }, cors);
  if (path === "/api/health") {
    // source と version はソース提供ページ（/source）が読む
    return json(200, { ok: true, stage: STAGE, norm_v: tags.RULES.norm_v, source: SOURCE_URL, version: VERSION }, cors);
  }

  // 法務ページは誰でも読めなければ意味がない（IP制限の手前に置く）
  if (method === "GET" && LEGAL[path.slice(1)]) return html(200, legalPage(path.slice(1)), cors);
  if (method === "GET" && ASSETS[path]) {
    return {
      statusCode: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "x-robots-tag": "noindex, nofollow",
        ...cors,
      },
      body: ASSETS[path],
    };
  }
  if (method === "GET" && path === "/license") {
    return { statusCode: 200, headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex", ...cors }, body: LICENSE };
  }

  if (!ipAllowed(ip)) {
    return { statusCode: 403, headers: { "content-type": "text/plain; charset=utf-8", ...cors }, body: `Forbidden (${ip})` };
  }

  // 動作確認用の最小Web面と、そこから読み込む正規化の解釈器
  if (method === "GET" && (path === "/" || path === "/search")) return html(200, PAGE, cors);
  if (method === "GET" && path === "/v1/normalize.mjs") {
    return {
      statusCode: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "x-robots-tag": "noindex, nofollow",
        ...cors,
      },
      body: NORMALIZER,
    };
  }

  try {
    return await route(event, { method, path, ip, cors });
  } catch (err) {
    if (err instanceof ApiError) {
      const { status, code, ...extra } = err;
      return json(status, { error: code, ...extra }, cors);
    }
    // ★ エラーログにURLやIPを載せない（04 §7）
    console.error(err.name, err.message);
    return json(500, { error: "server_error" }, cors);
  }
}
