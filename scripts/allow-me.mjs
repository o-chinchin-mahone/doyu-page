// 今このPCのグローバルIP（IPv4 / IPv6）を、許可リスト（SSM）に入れる
//   stages.json ではなく SSM に書くので、自宅IPが公開リポジトリの履歴に残らない（M0 決定4）
//   反映には再デプロイが要る（環境変数として注入するため）: STAGE=dev npm run deploy
import https from "node:https";
import { LambdaClient, GetFunctionUrlConfigCommand } from "@aws-sdk/client-lambda";
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import { REGION, STAGE, names } from "./config.mjs";

const n = names();
const { FunctionUrl } = await new LambdaClient({ region: REGION })
  .send(new GetFunctionUrlConfigCommand({ FunctionName: n.func }));
const WHOAMI = new URL("api/whoami", FunctionUrl);

function whoami(family) {
  return new Promise((resolve) => {
    https.get(WHOAMI, { family, timeout: 10000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body).ip); } catch { resolve(null); } });
    }).on("error", () => resolve(null)).on("timeout", function () { this.destroy(); });
  });
}

function v6Prefix64(ip) {
  const [left, right = ""] = ip.split("::");
  const l = left ? left.split(":") : [];
  const r = right ? right.split(":") : [];
  const groups = ip.includes("::") ? [...l, ...Array(8 - l.length - r.length).fill("0"), ...r] : l;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

const v4 = await whoami(4);
const v6 = await whoami(6);
const cidrs = [...(v4 ? [`${v4}/32`] : []), ...(v6 ? [v6Prefix64(v6)] : [])];
if (!cidrs.length) throw new Error("IPを取得できませんでした");
console.log(`IPv4: ${v4 ?? "(なし)"}  IPv6: ${v6 ?? "(なし)"}`);

await new SSMClient({ region: REGION }).send(new PutParameterCommand({
  Name: n.allowedIpsParam, Value: cidrs.join(","), Type: "String", Overwrite: true,
}));
console.log(`✓ ${n.allowedIpsParam} = ${cidrs.join(", ")}`);
console.log(`\n反映するには再デプロイしてください: STAGE=${STAGE} npm run deploy`);
