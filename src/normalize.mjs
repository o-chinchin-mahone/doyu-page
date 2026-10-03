// URL正規化（docs/04 §9）
//
//   ★この1ファイルがサーバーと拡張の両方で動く。別実装にすると1文字ズレただけで
//     ハッシュが一致せず「タグが1件も出ない・しかもサイレント」になる。
//   ★全サイト共通の1ルールだけ持つ（2026-09-23 の決定）。
//     サイト別の正準化（youtu.be → youtube.com/watch 等）は持たない。その帰結:
//       - 同じ動画でも youtu.be と youtube.com はそれぞれ別ページ扱い
//       - "?t=42s"（42秒から共有）付きのURLも別ページ扱い
//     ただしリダイレクトする短縮URLは、投稿時の公開性検証で追跡した最終URLを採る（tags.mjs）。
//   Node 専用APIを使わない（拡張の Service Worker にそのまま載せるため）。
export class NormalizeError extends Error {
  constructor(code) { super(code); this.name = "NormalizeError"; this.code = code; }
}

/**
 * 正規化する。戻り値の `url` が url_hash の入力になる。
 * 消すのは www. と # 以降だけ。パスとクエリはそのまま残す。
 * @returns {{url:string, host:string, norm_v:number}}
 * @throws {NormalizeError} code: invalid_url / scheme / no_host
 */
export function normalizeUrl(raw, rules) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new NormalizeError("invalid_url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new NormalizeError("scheme");
  if (!u.hostname) throw new NormalizeError("no_host");

  let host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (rules.strip_www && host.startsWith("www.")) host = host.slice(4);

  const port = u.port ? `:${u.port}` : "";
  const fragment = rules.drop_fragment === false ? u.hash : "";

  return {
    url: `${u.protocol}//${host}${port}${u.pathname}${u.search}${fragment}`,
    host,
    norm_v: rules.norm_v,
  };
}
