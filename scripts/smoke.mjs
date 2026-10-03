// デプロイ後の動作確認: Lambda を直接呼んで一通り通ることを確かめる
//   CI の IP は許可リストに無いので、許可IPを模したイベントで呼ぶ
//   ★ 本番にデータを作らないよう、書き込み経路は「拒否されること」だけ確認する
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { REGION, STAGE, EXTENSION_ID, names } from "./config.mjs";

const lambda = new LambdaClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const n = names();

const param = async (Name) => {
  try {
    return (await ssm.send(new GetParameterCommand({ Name }))).Parameter.Value;
  } catch (e) {
    if (e.name === "ParameterNotFound") return "";
    throw e;
  }
};

const allowedIps = await param(n.allowedIpsParam);
const sourceIp = allowedIps.split(",")[0]?.trim().split("/")[0].replace(/::$/, "::1") || "192.0.2.1";

// 直撃防御が有効なら、正常系の呼び出しには合言葉を付ける（Worker を模す）。
// smoke は Function URL ではなく Lambda を直接 Invoke するので、付けないと全部 403 になる。
const originEnforced = (await param(n.originEnforceParam)) === "on";
const originSecret = originEnforced ? await param(n.originSecretParam) : "";

async function call(method, rawPath, { query = "", headers = {}, body } = {}) {
  const r = await lambda.send(new InvokeCommand({
    FunctionName: n.func,
    Payload: JSON.stringify({
      rawPath, rawQueryString: query,
      headers: {
        ...(originEnforced ? { "x-doyu-origin": originSecret } : {}),
        ...headers,
      },
      requestContext: { http: { method, sourceIp } },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  }));
  if (r.FunctionError) throw new Error(`${method} ${rawPath}: ${Buffer.from(r.Payload).toString()}`);
  return JSON.parse(Buffer.from(r.Payload).toString());
}

const params = await call("GET", "/v1/params");
if (params.statusCode !== 200) throw new Error(`/v1/params → ${params.statusCode}: ${params.body}`);
// 読み取りの鍵は URL のハッシュ（64文字）。存在しないハッシュでも 200（items が空）
const absentHash = "0".repeat(64);

const checks = [
  ["GET", "/api/health", {}, 200],
  ["GET", "/api/whoami", {}, 200],
  ["GET", "/", {}, 200],                                   // 最小Web面
  ["GET", "/v1/normalize.mjs", {}, 200],                   // 正規化の解釈器（Web面が読み込む）
  ["GET", "/v1/norm-rules", {}, 200],                      // 正規化ルール
  ["GET", "/v1/tags", { query: `hash=${absentHash}` }, 200], // URL のハッシュで引く
  ["GET", "/v1/tags", { query: "hash=zz" }, 400],            // 部分一致・不正な長さは 400
  ["GET", "/v1/search", { query: "domain=youtube.com&tag=メヒカリ" }, 200],
  ["POST", "/v1/tags", { body: { url: "https://example.com/x", tag: "x" } }, 401], // トークン必須
  ["OPTIONS", "/v1/tags", { headers: { origin: `chrome-extension://${EXTENSION_ID}` } }, 204],
  // 法務ページ（M4a）
  ["GET", "/terms", {}, 200],
  ["GET", "/privacy", {}, 200],
  ["GET", "/takedown", {}, 200],
  ["GET", "/transmission", {}, 200],
  ["GET", "/source", {}, 200],
  ["GET", "/license", {}, 200],
];

let failed = false;
for (const [method, path, options, expected] of checks) {
  const res = await call(method, path, options);
  const ok = res.statusCode === expected;
  failed ||= !ok;
  console.log(`${ok ? "✓" : "✗"} ${method} ${path}${options.query ? `?${options.query}` : ""} → ${res.statusCode}（期待 ${expected}）`);
}

// 直撃防御が有効なら、合言葉の無い（＝Worker を通っていない）リクエストが 403 で落ちることを確かめる。
// これが緑でないと、CI デプロイで ORIGIN_SECRET が消えて防御が外れていても気づけない（docs/11 §🟠）
if (originEnforced) {
  const res = await call("GET", "/api/health", { headers: { "x-doyu-origin": "wrong-secret" } });
  const ok = res.statusCode === 403;
  failed ||= !ok;
  console.log(`${ok ? "✓" : "✗"} GET /api/health（合言葉なし＝直撃）→ ${res.statusCode}（期待 403）`);
}
if (failed) process.exit(1);
console.log(`\n${STAGE} スモークテスト OK（norm_v=${JSON.parse(params.body).norm_v}）`);
