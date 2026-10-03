// 法務フェーズ0（docs/09 M4a / 07 / 08）。「紙の上で通す」をやめ、CIで落とせる形にする
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.EXTENSION_ID = "fladmnjffgaplkjhjnhfgifbmcdcoldj";
process.env.INVITE_CODE = "test-invite";
process.env.TOKEN_SECRET = "test-secret";
process.env.VERIFY_PUBLIC = "0";

const { handler } = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const tags = await import("../src/tags.mjs");
const { normalizeUrl } = await import("../src/normalize.mjs");
const { prepareTag } = await import("../src/tag.mjs");

const call = (method, rawPath, { query = "", body, headers = {} } = {}) =>
  handler({
    rawPath, rawQueryString: query, headers,
    requestContext: { http: { method, sourceIp: "192.0.2.1" } },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("★法務ページは招待コード無しで誰でも読める（読めなければ公開した意味がない）", async () => {
  for (const path of ["/terms", "/privacy", "/takedown", "/transmission", "/source", "/license"]) {
    const res = await call("GET", path);
    assert.equal(res.statusCode, 200, path);
  }
});

test("★LICENSE がデプロイの zip に入る（src/ の外のファイルは入らない）", async () => {
  // Lambda では src/ の中身が /var/task に展開される。"../LICENSE" は /var/LICENSE を指し、
  // 読めずにモジュールの読み込みごと落ちる。デプロイ側で zip に入れること
  const { readFileSync } = await import("node:fs");
  const deploy = readFileSync(new URL("../scripts/deploy.mjs", import.meta.url), "utf8");
  assert.match(deploy, /addLocalFile\([\s\S]{0,60}LICENSE/);
});

test("ソースの提供が稼働バージョンと結びついている", async () => {
  assert.ok((await call("GET", "/license")).body.includes("PolyForm Shield License 1.0.0"));
  const health = JSON.parse((await call("GET", "/api/health")).body);
  assert.ok(health.source?.startsWith("https://"), "稼働中のソース入手先が配られていない");
  assert.ok(health.version);
});

test("★管理者削除: 全経路から消え、本体は残り、記録が残る（08 §5-6）", async () => {
  const url = `https://blog.example.jp/entry/${randomUUID().slice(0, 6)}`;
  const tag = `タグ${randomUUID().slice(0, 6)}`;
  const anon = `poster-${randomUUID().slice(0, 8)}`;
  await tags.postTag({ url, tag, anon, verify: null });

  const hash = store.urlHash(normalizeUrl(url, tags.RULES).url);
  const { tag_id } = prepareTag(tag);

  await store.setTagStatus(hash, tag_id, "removed");
  await store.putTakedownLog({ action: "removed", url, url_hash: hash, tag, tag_id, clause: "3", reason: "テスト" });

  // 検索にもタグ一覧にも出ない
  assert.equal((await tags.search({ domain: "blog.example.jp", tag })).items.length, 0);
  const bucket = await tags.readTagsOfUrl(hash);
  assert.ok(!bucket.some((i) => i.url_hash === hash && i.tag_id === tag_id));

  // 本体は物理削除しない（保全。30日は復旧できる）
  const item = await store.getTag(hash, tag_id);
  assert.equal(item.status, "removed");
  assert.equal(item.url, normalizeUrl(url, tags.RULES).url);

  // 記録が残る
  const db = await store.backend();
  const ym = new Date().toISOString().slice(0, 7).replace("-", "");
  const logs = (await db.query({ pk: `LOG#${ym}` })).items;
  assert.ok(logs.some((l) => l.tag_id === tag_id && l.clause === "3"));

  // 復旧できる
  await store.setTagStatus(hash, tag_id, "active");
  assert.equal((await tags.search({ domain: "blog.example.jp", tag })).items.length, 1);
});

test("★muted は「ページ上から見えないが検索には出る」（03 §2。荒らし対応の中心）", async () => {
  const url = `https://blog.example.jp/entry/${randomUUID().slice(0, 6)}`;
  const tag = `荒らし${randomUUID().slice(0, 6)}`;
  await tags.postTag({ url, tag, anon: `k-${randomUUID().slice(0, 8)}`, verify: null });

  const hash = store.urlHash(normalizeUrl(url, tags.RULES).url);
  const { tag_id } = prepareTag(tag);
  const onPage = async () => (await tags.readTagsOfUrl(hash)).some((i) => i.tag_id === tag_id);

  assert.equal(await onPage(), true, "付けた直後は見えていないとおかしい");

  await store.setTagStatus(hash, tag_id, "muted");
  assert.equal(await onPage(), false, "muted がページ上に見えている");

  // ★これが本体。クライアントで隠すのでは駄目で、読み取りの応答に文字列自体が乗っていないこと。
  //   乗っていたら通信を覗くだけで読めてしまい、「見えない」が嘘になる
  const wire = await call("GET", "/v1/tags", {
    query: `hash=${hash}`, headers: { "x-doyu-invite": "test-invite" },
  });
  assert.equal(wire.statusCode, 200);
  assert.ok(!wire.body.includes(tag), "★muted のタグ文字列が読み取りの応答に乗っている");
  assert.ok(!wire.body.includes(tag_id), "★muted の tag_id が読み取りの応答に乗っている");

  assert.equal((await tags.search({ domain: "blog.example.jp", tag })).items.length, 1,
    "★muted が検索から消えている。記録が消えるのは法的削除のときだけ");

  // 元に戻せる
  await store.setTagStatus(hash, tag_id, "active");
  assert.equal(await onPage(), true);
});

test("★表示寿命: 到達の無いタグは猶予を過ぎるとページから消えるが、検索には残る（03 §2）", async () => {
  const url = `https://blog.example.jp/entry/${randomUUID().slice(0, 6)}`;
  const tag = `寿命${randomUUID().slice(0, 6)}`;
  await tags.postTag({ url, tag, anon: `k-${randomUUID().slice(0, 8)}`, verify: null });

  const hash = store.urlHash(normalizeUrl(url, tags.RULES).url);
  const { display_grace_days, display_life_days } = await store.config();
  const { tag_id } = prepareTag(tag);
  const day = 86400_000;
  const onPageAt = async (at) => (await tags.readTagsOfUrl(hash, at)).some((i) => i.tag_id === tag_id);

  // 猶予のうちは見える（新しいタグに露出の機会を与える）
  assert.equal(await onPageAt(Date.now() + (display_grace_days - 1) * day), true);
  // 猶予を過ぎ、到達が無ければ見えなくなる
  assert.equal(await onPageAt(Date.now() + (display_grace_days + 1) * day), false);
  // ★寿命切れも同じ。文字列が応答に乗らないこと（クライアントで隠すのでは意味がない）
  const wire = await call("GET", "/v1/tags", {
    query: `hash=${hash}`, headers: { "x-doyu-invite": "test-invite" },
    // readTagsOfUrl の now はサーバーの時計なので、ここは 0 到達 + 猶予内 = 見えている状態の確認に使う
  });
  assert.ok(wire.body.includes(tag), "猶予内なのに見えていない");
  // それでも検索には出る＝記録は残っている
  assert.equal((await tags.search({ domain: "blog.example.jp", tag })).items.length, 1);

  // 到達を1回記録すると、そこから寿命のあいだ見える
  const rec = await tags.recordReach({ url_hash: hash, tag_id });
  assert.equal(rec.recorded, true);
  assert.equal(await onPageAt(Date.now() + (display_grace_days + 1) * day), true, "到達したのに沈んでいる");
  assert.equal(await onPageAt(Date.now() + (display_life_days + 1) * day), false, "寿命が切れていない");
});

test("到達は存在しない組み合わせを問い合わせる道具にならない（在否を返さない形で 200）", async () => {
  const fake = "f".repeat(64);
  const res = await call("POST", "/v1/reach", {
    headers: { "x-doyu-invite": "test-invite" },
    body: { url_hash: fake, tag_id: "aaaaaaaaaaaaaaaa" },
  });
  assert.equal(res.statusCode, 200);
  // 形が違うものは 400（叩き放題の入口にしない）
  const bad = await call("POST", "/v1/reach", {
    headers: { "x-doyu-invite": "test-invite" }, body: { url_hash: "zz", tag_id: "!" },
  });
  assert.equal(bad.statusCode, 400);
});

test("★投稿者という概念を外に出さない（通知経路も持たない）", async () => {
  const { issueToken } = await import("../src/token.mjs");
  const headers = { "x-doyu-invite": "test-invite", "x-doyu-token": issueToken("k-someone") };
  assert.equal((await call("GET", "/v1/notices", { headers })).statusCode, 404, "通知経路が生きている");

  const url = `https://blog.example.jp/entry/${randomUUID().slice(0, 6)}`;
  const tag = `匿名${randomUUID().slice(0, 6)}`;
  await tags.postTag({ url, tag, anon: "k-secret-key", verify: null });
  const hash = store.urlHash(normalizeUrl(url, tags.RULES).url);
  const bucket = await tags.readTagsOfUrl(hash);
  for (const item of bucket) {
    assert.ok(!("poster" in item), "読み取りに投稿元の鍵が混ざっている");
  }
  const found = JSON.parse((await call("GET", "/v1/search", {
    query: `domain=blog.example.jp&tag=${encodeURIComponent(tag)}`, headers,
  })).body);
  for (const item of found.items) assert.ok(!("poster" in item), "検索結果に投稿元の鍵が混ざっている");
});
