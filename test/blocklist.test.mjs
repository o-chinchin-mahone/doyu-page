// 書き込み経路のURLブロック（docs/05 §5）と公開性検証・SSRF対策（docs/05 §4.2）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeUrl } from "../src/normalize.mjs";
import { assertPostable, BlockedUrlError } from "../src/blocklist.mjs";
import { verifyPublic, PublicityError, isBlockedIp, headClosed } from "../src/publicity.mjs";
import { baseDomain, isPublicHost } from "../src/psl.mjs";

const RULES = JSON.parse(readFileSync(new URL("../src/data/norm-rules.json", import.meta.url), "utf8"));
const check = (url) => { normalizeUrl(url, RULES); assertPostable(url); };

test("通常のURLは通る（クエリが残っていても通す）", () => {
  for (const u of [
    "https://www.youtube.com/watch?v=abc123&t=9",
    "https://example.com/news?id=3",
    "https://x.com/someone/status/1234567890123456789",
    "https://blog.example.jp/entry/2026/09/23",
  ]) assert.doesNotThrow(() => check(u), u);
});

test("ヒューリスティック（辞書不要）で共有リンク・社内URLを落とす", () => {
  const cases = {
    "https://docs.google.com/document/d/1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvWx/edit": "high_entropy_path",
    "https://intra.local/page": "not_public_host",
    "http://192.168.1.5/wiki": "not_public_host",
    "http://localhost:3000/x": "not_public_host",
    "https://user:pw@example.com/a": "basic_auth",
    "https://example.com:8443/a": "port",
    "https://example.com/a?token=xyz": "sensitive_param",
    "https://www.city.example.go.jp/x": "sensitive_domain",
  };
  for (const [url, code] of Object.entries(cases)) {
    assert.throws(() => check(url), (e) => e instanceof BlockedUrlError && e.code === code, url);
  }
});

test("連番IDは秘密として扱わない（x.com の status を壊さない）", () => {
  assert.doesNotThrow(() => check("https://x.com/a/status/1234567890123456789"));
});

test("壊れたパーセントエンコードで 500 にしない", () => {
  assert.doesNotThrow(() => check("https://example.com/%E0%A4%A"));
});

test("PSL: 登録可能ドメインを取り出す／載らないホストを弾く", () => {
  assert.equal(baseDomain("www.youtube.com"), "youtube.com");
  assert.equal(baseDomain("a.b.example.co.jp"), "example.co.jp");
  assert.equal(isPublicHost("localhost"), false);
  assert.equal(isPublicHost("10.0.0.1"), false);
});

test("SSRF: プライベート／予約IPを拒否する（IPv4射影も）", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

const fake = (map) => async (u) => map[u] ?? { status: 404, headers: {}, body: "", url: u };

test("公開性検証: 匿名で200かつ noindex でないときだけ通す", async () => {
  const r = await verifyPublic("https://ok.example/a", {
    fetchImpl: fake({ "https://ok.example/a": { status: 200, headers: {}, body: "<title> ある動画 </title>" } }),
  });
  assert.deepEqual(r, { finalUrl: "https://ok.example/a", title: "ある動画" });
});

test("★robots.txt の Disallow では拒否しない（docs/09 M1 決定8）", async () => {
  // x.com は `User-agent: * / Disallow: /`。尊重すると X には永久にタグを付けられない。
  // 巡回ではなく、ユーザーが選んだ1ページを1回取りに行くだけなので見ない
  const r = await verifyPublic("https://x.example/user/status/1", {
    fetchImpl: fake({
      "https://x.example/user/status/1": { status: 200, headers: {}, body: "<title>ある投稿</title>" },
      "https://x.example/robots.txt": { status: 200, headers: {}, body: "User-agent: *\nDisallow: /" },
    }),
  });
  assert.equal(r.title, "ある投稿");
});

test("<head> が閉じたら読むのをやめる（YouTube の title は 700KB 地点にある）", () => {
  assert.equal(headClosed("<html><head><title>x</title></head>"), true);
  assert.equal(headClosed("</HEAD >"), true);
  assert.equal(headClosed("<html><head><title>x</title>"), false);
});

test("公開性検証: ログイン必須・noindex・404 を落とす", async () => {
  const cases = [
    ["noindex ヘッダ", { "https://e1.example/a": { status: 200, headers: { "x-robots-tag": "noindex" }, body: "" } }, "noindex"],
    ["noindex メタタグ", { "https://e2.example/a": { status: 200, headers: {}, body: '<meta name="robots" content="noindex, nofollow">' } }, "noindex"],
    ["404", { "https://e3.example/a": { status: 404, headers: {}, body: "" } }, "status_404"],
  ];
  for (const [name, map, code] of cases) {
    const url = Object.keys(map)[0];
    await assert.rejects(
      () => verifyPublic(url, { fetchImpl: fake(map) }),
      (e) => e instanceof PublicityError && e.code === code,
      name,
    );
  }
});

test("短縮URLはリダイレクトを追って展開される（追いすぎは拒否）", async () => {
  const r = await verifyPublic("https://t.co/abcd", {
    fetchImpl: fake({
      "https://t.co/abcd": { status: 301, headers: { location: "https://ok.example/real" }, body: "" },
      "https://ok.example/real": { status: 200, headers: {}, body: "<title>x</title>" },
    }),
  });
  assert.equal(r.finalUrl, "https://ok.example/real");

  const loop = async (u) => ({ status: 302, headers: { location: `${u}/x` }, body: "", url: u });
  await assert.rejects(
    () => verifyPublic("https://loop.example/a", { fetchImpl: loop }),
    (e) => e.code === "too_many_redirects",
  );
});

test("★接続には IPv4 を選ぶ（VPC外の Lambda は IPv6 で外に出られない）", async () => {
  const { pickAddress } = await import("../src/publicity.mjs");
  // dns.lookup は AAAA を先に返すことがある。先頭をそのまま使うと ENETUNREACH になる
  assert.equal(
    pickAddress([{ address: "2404:6800::1", family: 6 }, { address: "142.250.207.14", family: 4 }]).address,
    "142.250.207.14",
  );
  // IPv4 が無いときは仕方なく IPv6 を使う
  assert.equal(pickAddress([{ address: "2404:6800::1", family: 6 }]).family, 6);
});

test("★固定した lookup は all:true でも答えられる（Node 20+ の Happy Eyeballs）", async () => {
  const { pinnedLookup } = await import("../src/publicity.mjs");
  const lookup = pinnedLookup({ address: "142.250.207.14", family: 4 });

  // Node 20 以降の net.connect は既定でこちらを呼ぶ。配列で返さないと ERR_INVALID_IP_ADDRESS
  const all = await new Promise((r) => lookup("youtube.com", { all: true }, (_e, v) => r(v)));
  assert.deepEqual(all, [{ address: "142.250.207.14", family: 4 }]);

  // 従来の形（単一アドレス）も壊さない
  const one = await new Promise((r) => lookup("youtube.com", {}, (_e, a, f) => r([a, f])));
  assert.deepEqual(one, ["142.250.207.14", 4]);
});
