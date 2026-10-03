// URL正規化のゴールデンテスト（docs/09-roadmap.md M1 の完了条件）
//
//   ★ここが1文字ズレると prefix が一致せず、タグが1件も出ない。しかもサイレントに失敗する。
//     だから「同一入力に対しサーバーとクライアントが同じ url_hash を出す」ことを
//     CI が毎回検証する。
//   ★ルールは全サイト共通の1つだけ（2026-09-23 の決定）。サイト別の正準化は持たない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeUrl, NormalizeError } from "../src/normalize.mjs";
import { urlHash } from "../src/store.mjs";

const RULES = JSON.parse(readFileSync(new URL("../src/data/norm-rules.json", import.meta.url), "utf8"));

// 期待値は固定する。変えるときは norm_v を上げること（既存の url_hash が全て変わるため）
const GOLDEN = [
  // 消すのは www. と # 以降だけ。パスもクエリもそのまま残す
  ["https://www.youtube.com/watch?v=abc123", "https://youtube.com/watch?v=abc123"],
  ["https://www.youtube.com/watch?v=abc123&t=42s", "https://youtube.com/watch?v=abc123&t=42s"],
  ["https://youtu.be/abc123", "https://youtu.be/abc123"],
  ["https://example.com/news?id=5&utm_source=x", "https://example.com/news?id=5&utm_source=x"],
  ["https://example.com/a/b/#section", "https://example.com/a/b/"],
  ["https://EXAMPLE.com/Path", "https://example.com/Path"], // ホストだけ小文字化、パスの大小は保つ
  ["https://example.com", "https://example.com/"],
  ["http://example.com/a", "http://example.com/a"],         // スキームも変えない
  ["https://x.com/Someone/status/12345", "https://x.com/Someone/status/12345"],
];

test("ゴールデン: 正規化結果は固定（変えるなら norm_v を上げる）", () => {
  for (const [input, expected] of GOLDEN) {
    assert.equal(normalizeUrl(input, RULES).url, expected, input);
  }
});

test("サイト別の正準化は持たない＝表記が違えば別ページになる", () => {
  // この割り切りの代償。投稿時はリダイレクト追跡（公開性検証）だけが表記ゆれを吸収する
  const a = urlHash(normalizeUrl("https://www.youtube.com/watch?v=abc123", RULES).url);
  const b = urlHash(normalizeUrl("https://youtu.be/abc123", RULES).url);
  const c = urlHash(normalizeUrl("https://www.youtube.com/watch?v=abc123&t=42s", RULES).url);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("www の有無は吸収する", () => {
  assert.equal(
    urlHash(normalizeUrl("https://www.example.com/a", RULES).url),
    urlHash(normalizeUrl("https://example.com/a", RULES).url),
  );
});

test("★サーバーとクライアントが同じ url_hash を出す（解釈器は1つしかない）", async () => {
  // Web面・拡張は GET /v1/norm-rules で配られたルールを、同じ解釈器に食わせる。
  process.env.VERIFY_PUBLIC = "0";
  const { handler } = await import("../src/index.mjs");
  const res = await handler({
    rawPath: "/v1/norm-rules", rawQueryString: "", headers: {},
    requestContext: { http: { method: "GET", sourceIp: "192.0.2.1" } },
  });
  const served = JSON.parse(res.body);
  assert.equal(served.norm_v, RULES.norm_v);
  for (const [input] of GOLDEN) {
    assert.equal(
      urlHash(normalizeUrl(input, served).url),
      urlHash(normalizeUrl(input, RULES).url),
      input,
    );
  }
});

test("扱えない入力は理由つきで拒否する", () => {
  const rejects = [
    ["file:///etc/passwd", "scheme"],
    ["chrome://settings", "scheme"],
    ["ほげ", "invalid_url"],
  ];
  for (const [input, code] of rejects) {
    assert.throws(() => normalizeUrl(input, RULES), (e) => e instanceof NormalizeError && e.code === code, input);
  }
});
