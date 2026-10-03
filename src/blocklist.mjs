// 送信を禁止すべきURL（書き込み経路のみの多層防御。docs/05 §5）
//
//   ★判定は「正規化前の原URL」に対して行う。正規化はクエリを落とすので、
//     正規化後に見ると「クエリに認証情報が入っている」ことが検出できなくなる。
//   ブロックリストは fail-open で必ず漏れる。一次防御は、読み取りではフルURLを送らないこと、
//     書き込みでは明示的な確定操作であって、この層ではない。
import { readFileSync } from "node:fs";
import { baseDomain, isPublicHost } from "./psl.mjs";

const DENY = JSON.parse(readFileSync(new URL("./data/url-deny.json", import.meta.url), "utf8"));

export class BlockedUrlError extends Error {
  constructor(code) { super(code); this.name = "BlockedUrlError"; this.code = code; }
}

// 高エントロピー文字列（共有リンクのID＝実質的な認証情報）の検出。
//   Google Docs / Figma / Notion の共有リンクは ID がクエリではなくパスにある
const MIN_SECRET_LEN = 20;
function looksLikeSecret(segment) {
  if (segment.length < MIN_SECRET_LEN) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  if (/^\d+$/.test(segment)) return false; // 連番ID（x.com の status 等）は秘密ではない
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(segment)).length;
  if (classes < 2) return false;
  const freq = new Map();
  for (const ch of segment) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) { const p = n / segment.length; bits -= p * Math.log2(p); }
  return bits >= 3.0;
}

/**
 * 原URLを検査する。問題があれば BlockedUrlError を投げる。
 * @param {string} raw 投稿されたURL（正規化前）
 */
export function assertPostable(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new BlockedUrlError("invalid_url"); }

  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (DENY.schemes.includes(scheme)) throw new BlockedUrlError("scheme");
  if (scheme !== "http" && scheme !== "https") throw new BlockedUrlError("scheme");

  if (u.username || u.password) throw new BlockedUrlError("basic_auth");

  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  // PSL に載らないホスト（社内ドメイン・生IP・localhost・*.local）。
  // 社内 Confluence 等はグローバルDNSで解決されるため、プライベートIP除外だけでは抜ける
  // ★ポート検査より先に置く。localhost:3000 の理由が "port" になると原因が分かりにくい
  if (!isPublicHost(host)) throw new BlockedUrlError("not_public_host");
  if (u.port) throw new BlockedUrlError("port"); // 既定ポート以外＝社内サービスの可能性が高い
  const base = baseDomain(host);
  if (DENY.host_denylist.includes(base)) throw new BlockedUrlError("host_denylist");
  if (DENY.host_suffixes.some((s) => host === s || host.endsWith(`.${s}`))) {
    throw new BlockedUrlError("sensitive_domain");
  }

  for (const segment of u.pathname.split("/")) {
    // 壊れたパーセントエンコードは decodeURIComponent が投げるので、その場合は原文で見る
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { decoded = segment; }
    if (looksLikeSecret(decoded)) throw new BlockedUrlError("high_entropy_path");
  }

  for (const [name] of u.searchParams) {
    if (DENY.sensitive_params.includes(name.toLowerCase())) throw new BlockedUrlError("sensitive_param");
  }
}

export const _looksLikeSecret = looksLikeSecret;
