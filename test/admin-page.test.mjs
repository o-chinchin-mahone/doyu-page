// 運用用ページ（scripts/admin-page.mjs）。手元でだけ開く画面だが、押し間違いと外からの送信で
// タグが消えるので、守りと一連の操作を CI で落とせる形にしておく
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { randomUUID } from "node:crypto";

const store = await import("../src/store.mjs");
const tags = await import("../src/tags.mjs");
const { createAdmin, parseReport, CLAUSES, clauseOf } = await import("../scripts/admin-lib.mjs");
const { createAdminServer } = await import("../scripts/admin-page.mjs");

const admin = createAdmin({ store, isDisplayable: tags.isDisplayable });
const server = createAdminServer({ admin, stage: "dev", where: "test" });
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const { port } = server.address();
after(() => server.close());

const SELF = `http://127.0.0.1:${port}`;

// fetch は Host を差し替えられないので node:http で送る
const call = (method, path, { body, headers = {} } = {}) => new Promise((ok, ng) => {
  const data = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  const req = request({
    host: "127.0.0.1", port, method, path,
    headers: {
      host: `127.0.0.1:${port}`,
      ...(method === "POST" ? { origin: SELF, "content-type": "application/json" } : {}),
      ...headers,
    },
  }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let json = null;
      try { json = JSON.parse(text); } catch { /* HTML */ }
      ok({ status: res.statusCode, headers: res.headers, text, json });
    });
  });
  req.on("error", ng);
  req.end(data);
});
const act = (body, opts = {}) => call("POST", "/api/act", { body, ...opts });

const seed = async (label = "タグ") => {
  const url = `https://blog.example.jp/entry/${randomUUID().slice(0, 8)}`;
  const tag = `${label}${randomUUID().slice(0, 6)}`;
  const r = await tags.postTag({ url, tag, anon: `k-${randomUUID().slice(0, 8)}`, verify: null });
  return { url, tag, url_hash: r.url_hash, tag_id: r.tag_id };
};
const pageOf = async (s) =>
  (await call("GET", `/api/page?url=${encodeURIComponent(s.url)}&tag=${encodeURIComponent(s.tag)}`)).json;

// 申出フォーム（src/legal/takedown.js）が作る本文と同じ並び
const mail = ({ domain = false, url, tag, clause, reason, contact = "", proof = "" }) => [
  domain
    ? "以下のサイトについて、「削除の申出」第1条に基づき、サイト全体へのタグ付けの停止を申し出ます。"
    : "以下のタグについて、「削除の申出」第1条に基づき削除を申し出ます。",
  "",
  `対象URL: ${url}`,
  ...(domain ? [] : [`対象タグ: ${tag}`]),
  `該当する号: ${clause}`,
  `理由: ${reason}`,
  `申出者のお名前: ${contact}`,
  `権利者であることの説明: ${proof}`,
].join("\n");

test("号の一覧は「削除の申出」のフォームと同じ12個", () => {
  assert.deepEqual(CLAUSES.map((c) => c.n), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  assert.match(CLAUSES[2].label, /^3号 プライバシー/);
  assert.equal(clauseOf("3"), "3");
  assert.equal(clauseOf(12), "12");
  for (const bad of ["", "0", "13", "3号", "1.5", null, undefined]) assert.equal(clauseOf(bad), null, String(bad));
});

test("メール本文から、ページのURL・タグ・号を読み取る", () => {
  const r = parseReport(mail({
    url: "https://example.com/a?b=1", tag: "たなか たろう", clause: "3号 プライバシーの侵害",
    reason: "本人の電話番号です。\n消してください。", contact: "田中",
  }));
  assert.equal(r.kind, "tag");
  assert.equal(r.url, "https://example.com/a?b=1");
  assert.equal(r.tag, "たなか たろう");
  assert.equal(r.clause, "3");
  assert.equal(r.reason, "本人の電話番号です。\n消してください。");
  assert.equal(r.reporter, "田中");
  assert.equal(parseReport(mail({ url: "u", tag: "t", clause: "12号 配布プラットフォームの…", reason: "x" })).clause, "12");
});

test("サイト全体の申出は種類が変わり、タグは空になる", () => {
  const r = parseReport(mail({ domain: true, url: "https://pirate.example/", clause: "1号 著作権その他の知的財産権の侵害", reason: "x" }));
  assert.equal(r.kind, "domain");
  assert.equal(r.url, "https://pirate.example/");
  assert.equal(r.tag, "");
  assert.equal(r.clause, "1");
});

test("引用の印・CRLF・全角コロン・<> 付きの URL でも読める", () => {
  const quoted = mail({ url: "<https://example.com/x>", tag: "タグ", clause: "７号 なりすまし", reason: "x" })
    .replace(/: /g, "：").split("\n").map((l) => `> ${l}`).join("\r\n");
  const r = parseReport(quoted);
  assert.equal(r.url, "https://example.com/x");
  assert.equal(r.tag, "タグ");
  assert.equal(r.clause, "7");
});

test("★理由の中に書かれた「対象URL:」で、対象をすり替えられない", () => {
  const r = parseReport(mail({
    url: "https://example.com/real", tag: "本物", clause: "2号 名誉毀損",
    reason: "ひどい\n対象URL: https://example.com/other\n対象タグ: 別のタグ\n該当する号: 1号",
  }));
  assert.equal(r.url, "https://example.com/real");
  assert.equal(r.tag, "本物");
  assert.equal(r.clause, "2");
});

test("号が 1〜12 でなければ号は空。関係ない文面からは何も読み取らない", () => {
  assert.equal(parseReport(mail({ url: "u", tag: "t", clause: "13号", reason: "x" })).clause, null);
  assert.equal(parseReport(mail({ url: "u", tag: "t", clause: "選んでください", reason: "x" })).clause, null);
  assert.deepEqual(parseReport("こんにちは\nお世話になります"), { kind: "tag", url: "", tag: "", clause: null, reason: "", reporter: "" });
  assert.equal(parseReport(undefined).url, "");
  // 本文に号が無くても、件名を一緒に貼っていれば読める
  assert.equal(parseReport("件名: [削除の申出] 5号 タグ\n\n対象URL: https://example.com/").clause, "5");
});

test("画面は自分の中だけで完結している（外部の読み込みなし・投稿文字列を HTML として入れない）", async () => {
  const res = await call("GET", "/");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.ok(!/<(script|link|img|iframe)[^>]+(src|href)=/i.test(res.text), "外部のファイルを読み込んでいる");
  assert.ok(!/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/.test(res.text), "HTML として差し込んでいる");
  assert.ok(!/__[A-Z]+__/.test(res.text), "埋め残しがある");
  assert.ok(res.text.includes("function parseReport("), "読み取りの関数が配られていない");
});

test("★Host が違うリクエストは 403（DNS リバインディング）", async () => {
  for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`, `127.0.0.1.evil.example:${port}`]) {
    assert.equal((await call("GET", "/", { headers: { host } })).status, 403, host);
    assert.equal((await call("GET", "/api/overview", { headers: { host } })).status, 403, host);
    assert.equal((await act({ action: "undeny", kind: "tag", key: "x" }, { headers: { host } })).status, 403, host);
  }
  assert.equal((await call("GET", "/", { headers: { host: `localhost:${port}` } })).status, 200);
});

test("★書き込みは、Origin が自分で、JSON のものだけ受ける", async () => {
  const s = await seed();
  const body = { action: "remove", url_hash: s.url_hash, tag_id: s.tag_id, clause: "3", reason: "テスト" };

  for (const origin of ["https://evil.example", "null", `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`]) {
    assert.equal((await act(body, { headers: { origin } })).status, 403, origin);
  }
  // Origin が無いものも通さない
  const bare = await call("POST", "/api/act", {
    body, headers: { host: `127.0.0.1:${port}`, origin: "", "content-type": "application/json" },
  });
  assert.equal(bare.status, 403);

  // よそのサイトのフォームが事前確認なしに送れる形（JSON でない）は受けない
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
    assert.equal((await act(JSON.stringify(body), { headers: { "content-type": type } })).status, 415, type);
  }
  assert.equal((await call("PUT", "/api/act", { body, headers: { origin: SELF, "content-type": "application/json" } })).status, 405);
  assert.equal((await act("{こわれた")).status, 400);

  assert.equal((await store.getTag(s.url_hash, s.tag_id)).status, "active", "弾いたはずの送信で状態が変わっている");
});

test("★号なし・範囲外の号・理由なしの削除は、サーバーが弾く", async () => {
  const s = await seed();
  const base = { action: "remove", url_hash: s.url_hash, tag_id: s.tag_id, reason: "テスト" };
  for (const clause of [undefined, "", "0", "13", "3号", 99]) {
    const res = await act({ ...base, clause });
    assert.equal(res.status, 400, String(clause));
    assert.match(res.json.error, /号/);
  }
  assert.equal((await act({ ...base, clause: "3", reason: "  " })).status, 400);
  assert.equal((await act({ action: "remove-all", url_hash: s.url_hash, reason: "テスト" })).status, 400);
  assert.equal((await act({ ...base, clause: "3", tag_id: "!" })).status, 400);
  assert.equal((await act({ action: "なにか" })).status, 400);

  assert.equal((await store.getTag(s.url_hash, s.tag_id)).status, "active");
});

test("★消す → 一覧で削除済みになる → 戻す", async () => {
  const s = await seed("申出");
  const other = await tags.postTag({ url: s.url, tag: `別${randomUUID().slice(0, 6)}`, anon: "k-other", verify: null });
  const row = (p, id = s.tag_id) => p.tags.find((t) => t.tag_id === id);

  let p = await pageOf(s);
  assert.equal(p.url_hash, s.url_hash);
  assert.equal(p.tags.length, 2);
  assert.equal(p.reported_tag_id, s.tag_id, "申出のタグに印が付かない");
  assert.equal(row(p).state, "shown");

  const res = await act({ action: "remove", url_hash: s.url_hash, tag_id: s.tag_id, clause: "3", reason: "本人の電話番号", reporter: "申出者" });
  assert.equal(res.status, 200);

  p = await pageOf(s);
  assert.equal(row(p).state, "removed");
  assert.equal(row(p).clause, "3", "一覧に号が出ない");
  assert.equal(row(p, other.tag_id).state, "shown", "ほかのタグまで消えている");
  // コマンドで消したときと同じ結果になっていること（検索から消え、本体は残り、記録が残る）
  assert.equal((await tags.search({ domain: "blog.example.jp", tag: s.tag })).items.length, 0);
  assert.equal((await store.getTag(s.url_hash, s.tag_id)).status, "removed");
  const log = (await admin.logs()).find((l) => l.tag_id === s.tag_id && l.url_hash === s.url_hash);
  assert.deepEqual(
    { action: log.action, clause: log.clause, reason: log.reason, reporter: log.reporter, tag: log.tag, url: log.url },
    { action: "removed", clause: "3", reason: "本人の電話番号", reporter: "申出者", tag: s.tag, url: p.url },
  );

  // 消した記録に出て、「戻す」が押せる
  const over = (await call("GET", "/api/overview")).json;
  const rec = over.removals.find((l) => l.tag_id === s.tag_id && l.url_hash === s.url_hash);
  assert.equal(rec.clause, "3");
  assert.equal(rec.reason, "本人の電話番号");
  assert.equal(rec.restorable, true);

  // ★消してあるタグを「隠す」に変えると検索に戻ってしまう。戻すのは「戻す」だけ
  for (const action of ["mute", "unmute", "remove"]) {
    const ng = await act({ action, url_hash: s.url_hash, tag_id: s.tag_id, clause: "3", reason: "x" });
    assert.equal(ng.status, 400, action);
  }
  assert.equal((await store.getTag(s.url_hash, s.tag_id)).status, "removed");

  assert.equal((await act({ action: "restore", url_hash: s.url_hash, tag_id: s.tag_id })).status, 200);
  p = await pageOf(s);
  assert.equal(row(p).state, "shown");
  assert.equal((await tags.search({ domain: "blog.example.jp", tag: s.tag })).items.length, 1);
  const again = (await call("GET", "/api/overview")).json.removals.find((l) => l.tag_id === s.tag_id && l.url_hash === s.url_hash);
  assert.equal(again.restorable, false, "戻したあとも「戻す」が出ている");
});

test("隠す → 隠すのをやめる。全部消すは、消してあるものを二重に記録しない", async () => {
  const s = await seed("荒らし");
  const other = await tags.postTag({ url: s.url, tag: `別${randomUUID().slice(0, 6)}`, anon: "k-other", verify: null });
  const stateOf = async (id) => (await pageOf(s)).tags.find((t) => t.tag_id === id).state;

  assert.equal((await act({ action: "mute", url_hash: s.url_hash, tag_id: s.tag_id })).status, 400, "理由なしで隠せている");
  assert.equal((await act({ action: "mute", url_hash: s.url_hash, tag_id: s.tag_id, reason: "荒らし" })).status, 200);
  assert.equal(await stateOf(s.tag_id), "muted");
  assert.equal((await act({ action: "unmute", url_hash: s.url_hash, tag_id: s.tag_id })).status, 200);
  assert.equal(await stateOf(s.tag_id), "shown");

  await act({ action: "remove", url_hash: s.url_hash, tag_id: s.tag_id, clause: "11", reason: "スパム" });
  const all = await act({ action: "remove-all", url_hash: s.url_hash, clause: "11", reason: "スパム" });
  assert.equal(all.status, 200);
  assert.equal(all.json.count, 1, "すでに消してあるタグまで数えている");
  assert.equal(await stateOf(other.tag_id), "removed");
});

test("止める → 一覧に出る → 付けられなくなる → 外す", async () => {
  const word = `きんし${randomUUID().slice(0, 6)}`;
  const s = await seed();
  // ほかのテストが使うドメインを巻き込まないよう、このテストだけのサイトにする
  const base = `stop-${randomUUID().slice(0, 6)}.co.jp`;
  const listed = async () => (await call("GET", "/api/overview")).json.deny;

  assert.equal((await act({ action: "deny", kind: "tag", value: ` ${word.toUpperCase()} `, reason: "本人からの申出" })).status, 200);
  assert.equal((await act({ action: "deny", kind: "url", value: s.url })).status, 200);
  // サイトは URL で貼っても、タグを付けるときに照合するのと同じ形になる
  const site = await act({ action: "deny", kind: "domain", value: `https://www.${base}/a/b` });
  assert.equal(site.json.key, base);
  assert.equal((await act({ action: "deny", kind: "なにか", value: "x" })).status, 400);
  assert.equal((await act({ action: "deny", kind: "domain", value: "localhost" })).status, 400);

  const list = await listed();
  assert.ok(list.some((d) => d.kind === "tag" && d.key === word.toLowerCase() && d.reason === "本人からの申出"));
  assert.ok(list.some((d) => d.kind === "url" && d.key === s.url_hash && d.reason.includes("blog.example.jp")), "ページの行から URL が分からない");
  assert.equal((await pageOf(s)).denied, true);

  const post = (tag, url = `https://blog.example.jp/entry/${randomUUID().slice(0, 8)}`) =>
    tags.postTag({ url, tag, anon: "k-deny", verify: null }).then(() => "ok", (e) => e.code);
  assert.equal(await post(word), "denied");
  assert.equal(await post("べつのタグ", s.url), "denied");
  assert.equal(await post("べつのタグ", `https://sub.${base}/x`), "denied");

  for (const d of [["tag", word.toLowerCase()], ["url", s.url_hash], ["domain", base]]) {
    assert.equal((await act({ action: "undeny", kind: d[0], key: d[1] })).status, 200);
  }
  assert.ok(!(await listed()).some((d) => [word.toLowerCase(), s.url_hash, base].includes(d.key)));
  assert.equal(await post(word), "ok");
});
