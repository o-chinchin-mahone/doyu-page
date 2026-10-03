import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EXTENSION_ID = "fladmnjffgaplkjhjnhfgifbmcdcoldj";
process.env.INVITE_CODE = "test-invite";
const { handler } = await import("../src/index.mjs");

const call = (method, rawPath, { ip = "192.0.2.1", headers = {} } = {}) =>
  handler({ rawPath, headers, requestContext: { http: { method, sourceIp: ip } } });

test("health は誰でも叩ける", async () => {
  const r = await call("GET", "/api/health", { headers: { "x-doyu-invite": "test-invite" } });
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).ok, true);
});

test("whoami は招待コード無しでも叩ける（許可IP登録に使うため）", async () => {
  const r = await call("GET", "/api/whoami");
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).ip, "192.0.2.1");
});

test("招待コードが無いと 403", async () => {
  const r = await call("GET", "/api/tags");
  assert.equal(r.statusCode, 403);
});

test("レスポンスに noindex が付く（docs/01 §2.1）", async () => {
  const r = await call("GET", "/api/health");
  assert.match(r.headers["x-robots-tag"], /noindex/);
});

test("許可した拡張オリジンにだけ CORS を返す", async () => {
  const ok = await call("OPTIONS", "/api/tags", {
    headers: { origin: "chrome-extension://fladmnjffgaplkjhjnhfgifbmcdcoldj" },
  });
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers["access-control-allow-origin"], "chrome-extension://fladmnjffgaplkjhjnhfgifbmcdcoldj");

  const ng = await call("OPTIONS", "/api/tags", { headers: { origin: "https://evil.example" } });
  assert.equal(ng.headers["access-control-allow-origin"], undefined);
});
