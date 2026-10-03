// dev と prod が混ざらないことの検証（リソース名・IAM の Resource・署名鍵）
//   ここが壊れると、dev の事故が prod に飛ぶ。コードレビューでは気づけないので CI に置く
import { test } from "node:test";
import assert from "node:assert/strict";
import { names, STAGES, guardTargets, GUARD_CONCURRENCY } from "../scripts/config.mjs";
import { tableDefinition } from "../scripts/table.mjs";
import { readFileSync } from "node:fs";

test("ステージごとに別のリソース名になっている", () => {
  const dev = names("dev"), prod = names("prod");
  for (const key of Object.keys(dev)) {
    assert.notEqual(dev[key], prod[key], `${key} が dev と prod で同じ`);
  }
  assert.equal(dev.table, "doyu-dev-main");
  assert.equal(prod.table, "doyu-prod-main");
});

test("SSM は /doyu/<stage>/ の下に閉じている（署名鍵がステージで別）", () => {
  for (const stage of STAGES) {
    const n = names(stage);
    for (const param of [n.allowedIpsParam, n.tokenSecretParam, n.originSecretParam]) {
      assert.ok(param.startsWith(`/doyu/${stage}/`), `${param} が /doyu/${stage}/ の外にある`);
    }
  }
  // 署名鍵が別＝dev で発行したトークンは prod では検証に通らない
  assert.notEqual(names("dev").tokenSecretParam, names("prod").tokenSecretParam);
});

test("テーブル定義はステージ名を含む（テスト用テーブルとも混ざらない）", () => {
  assert.equal(tableDefinition(names("dev").table, "dev").TableName, "doyu-dev-main");
  assert.equal(tableDefinition(names("prod").table, "prod").TableName, "doyu-prod-main");
});

test("★予算ガードの対象は関数名だけ（IAM の Resource に同時実行数を混ぜない）", () => {
  // "doyu-dev:0" を ARN に埋めると function:doyu-dev:0 になり、これは「バージョン0」を指す。
  // PutFunctionConcurrency はバージョン指定できないため、権限が一致せず黙って AccessDenied になる。
  // ＝予算を超えても何も止まらない、という最悪の壊れ方をする
  for (const t of guardTargets()) {
    assert.ok(!t.func.includes(":"), `${t.func} に ":" が混ざっている`);
    assert.equal(t.limit, GUARD_CONCURRENCY[t.stage]);
  }
  assert.equal(guardTargets().find((t) => t.stage === "dev").limit, 0, "dev は止めてよい");
  assert.ok(guardTargets().find((t) => t.stage === "prod").limit > 0, "prod は止めずに絞る（04 §8）");
});

test("★組み込み関数を map にそのまま渡さない（添字が第2引数に入る）", () => {
  // structuredClone(value, index) は Node 22 で「オプションが辞書でない」と落ちる。
  // Node 18 は無視するので、手元だけ緑で CI が赤くなる類のバグになる
  const src = readFileSync(new URL("../src/store.mjs", import.meta.url), "utf8");
  assert.ok(!/\.map\(\s*structuredClone\s*\)/.test(src), ".map(structuredClone) が残っている");
  assert.ok(!/\.map\(\s*(JSON\.parse|Number|parseInt)\s*\)/.test(src));
});

test("★前段の合言葉が無いと Function URL 直撃を通してしまう（docs/09 M5）", async () => {
  const { clientIp } = await import("../src/index.mjs");
  const event = (headers) => ({
    headers, rawPath: "/", rawQueryString: "",
    requestContext: { http: { method: "POST", sourceIp: "203.0.113.9" } },
  });
  // 合言葉が合っているときだけ、Worker が渡したクライアントIPを信用する
  assert.equal(clientIp(event({ "x-doyu-client-ip": "198.51.100.7" }), true), "198.51.100.7");
  // 信用できない相手が名乗っても無視する（発信者情報を偽装させない）
  assert.equal(clientIp(event({ "x-doyu-client-ip": "198.51.100.7" }), false), "203.0.113.9");
  assert.equal(clientIp(event({}), true), "203.0.113.9");
});

test("Worker はクライアントが名乗るヘッダを落としてから付け直す", () => {
  const worker = readFileSync(new URL("../cloudflare/worker.js", import.meta.url), "utf8");
  for (const h of ["x-doyu-origin", "x-doyu-client-ip", "cf-connecting-ip", "x-forwarded-for"]) {
    assert.ok(worker.includes(`"${h}"`), `${h} を落としていない`);
  }
  // エッジキャッシュは切り替えられる形で持つ（いまは off。理由は worker.js のコメント）
  assert.match(worker, /EDGE_CACHE === "on"/);
});

test("★Worker はデータセンターからの書き込みだけを断る（読み取りと匿名IDの発行は通す）", async () => {
  const { default: worker, DATACENTER_ASNS } = await import("../cloudflare/worker.js");
  const env = { ORIGIN: "https://origin.test", ORIGIN_SECRET: "s" };
  const realFetch = globalThis.fetch;
  let passed = 0;
  globalThis.fetch = async () => { passed++; return new Response("{}", { status: 200 }); };
  // Node の Request は本文を流すときに duplex の指定を求める（Workers の実行環境では要らない）
  const RealRequest = globalThis.Request;
  globalThis.Request = class extends RealRequest {
    constructor(input, init) { super(input, init?.body ? { ...init, duplex: "half" } : init); }
  };
  const hit = (method, path, asn) => {
    const req = new Request(`https://edge.test${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
    Object.defineProperty(req, "cf", { value: { asn } });
    return worker.fetch(req, env);
  };
  try {
    const dc = [...DATACENTER_ASNS][0];
    for (const path of ["/v1/tags", "/v1/tags/undo", "/v1/reach", "/v1/kpi"]) {
      const res = await hit("POST", path, dc);
      assert.equal(res.status, 403, path);
      assert.equal((await res.json()).error, "datacenter_blocked");
    }
    assert.equal(passed, 0, "断ったはずの書き込みが後ろへ届いている");
    assert.equal((await hit("GET", "/v1/tags", dc)).status, 200);
    assert.equal((await hit("POST", "/v1/hello", dc)).status, 200);
    // 家庭の回線（NTT の OCN）と、番号が取れないときは通す
    assert.equal((await hit("POST", "/v1/tags", 4713)).status, 200);
    assert.equal((await hit("POST", "/v1/tags", undefined)).status, 200);
    // ブラウザやOSの中継に使われる事業者は載せない
    for (const relay of [13335, 36183, 54113]) assert.ok(!DATACENTER_ASNS.has(relay), String(relay));
  } finally { globalThis.fetch = realFetch; globalThis.Request = RealRequest; }
});
