// Lambda と公開 URL を作成・更新する（GitHub Actions から実行される）
//   土台（テーブル・ロール・SSM）は infra.mjs で作成済みであること
//   許可IPと招待コードは stages.json ではなく SSM から読む（M0 決定4）
import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import {
  LambdaClient, GetFunctionCommand, CreateFunctionCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand,
  GetFunctionUrlConfigCommand, CreateFunctionUrlConfigCommand, AddPermissionCommand,
  waitUntilFunctionActiveV2, waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { REGION, STAGE, EXTENSION_ID, names } from "./config.mjs";
import { accountId, ensure, sleep } from "./aws.mjs";

const lambda = new LambdaClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const account = await accountId();
const n = names();
const FunctionName = n.func;
const wait = () => waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName });

const param = async (Name, fallback = "") => {
  try {
    return (await ssm.send(new GetParameterCommand({ Name }))).Parameter.Value;
  } catch (e) {
    if (e.name === "ParameterNotFound") return fallback;
    throw e;
  }
};

const zip = new AdmZip();
zip.addLocalFolder(fileURLToPath(new URL("../src", import.meta.url)));
// src/ の外にあるが配信に要るもの。ライセンスの全文を返す（/license）
zip.addLocalFile(fileURLToPath(new URL("../LICENSE", import.meta.url)));
const ZipFile = zip.toBuffer();

const Environment = {
  Variables: {
    STAGE,
    TABLE_NAME: n.table,
    EXTENSION_ID,
    ALLOWED_IPS: await param(n.allowedIpsParam),
    INVITE_CODE: await param(n.inviteCodeParam),
    TOKEN_SECRET: await param(n.tokenSecretParam),
    // ★ Worker を立てるまでは空のまま。値を入れた瞬間、Function URL の直撃は 403 になる
    //   （Worker 側にも同じ値を wrangler secret put ORIGIN_SECRET で入れること）
    //   有効/無効の判断は SSM（origin-enforce）を正とする。こうしないと、一度有効にしても
    //   CI の `npm run deploy` は env を渡せず、UpdateFunctionConfiguration が Environment を
    //   丸ごと置換する結果 ORIGIN_SECRET が空に戻り、直撃防御が黙って外れる。
    //   手元からの緊急有効化用に env=enable も引き続き効かせる。
    ORIGIN_SECRET: (process.env.ORIGIN_SECRET === "enable" || (await param(n.originEnforceParam, "off")) === "on")
      ? await param(n.originSecretParam)
      : "",
    // 稼働中のバージョンに対応するソースを示せるようにする（/source）
    SOURCE_URL: process.env.SOURCE_URL ?? "https://github.com/o-chinchin-mahone/doyu-page",
    VERSION: (() => {
      try { return execSync("git rev-parse --short HEAD").toString().trim(); }
      catch { return "unknown"; }
    })(),
    // Web面を独自ドメインに載せたら設定する（CORS の許可オリジン。既定は拡張IDのみ）
    WEB_ORIGIN: process.env.WEB_ORIGIN ?? "",
  },
};
console.log(`デプロイ先: ${FunctionName}（${account} / ${REGION}）`);

const fn = await ensure(
  () => lambda.send(new GetFunctionCommand({ FunctionName })),
  async () => {
    // 作成直後のロールはまだ引き受けられないことがあるのでリトライ
    for (let i = 0; ; i++) {
      try {
        return await lambda.send(new CreateFunctionCommand({
          FunctionName, Runtime: "nodejs22.x", Handler: "index.handler",
          Role: `arn:aws:iam::${account}:role/${n.lambdaRole}`,
          Code: { ZipFile }, MemorySize: 256, Timeout: 10, Environment,
        }));
      } catch (e) {
        if (e.name === "InvalidParameterValueException" && i < 12) { await sleep(5000); continue; }
        throw e;
      }
    }
  },
);
if (fn.created) {
  await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 120 }, { FunctionName });
  console.log("✓ Lambda 作成");
} else {
  await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName, Environment }));
  await wait();
  await lambda.send(new UpdateFunctionCodeCommand({ FunctionName, ZipFile }));
  await wait();
  console.log("✓ Lambda 更新");
}

const url = await ensure(
  async () => (await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName }))).FunctionUrl,
  async () => {
    const { FunctionUrl } = await lambda.send(new CreateFunctionUrlConfigCommand({ FunctionName, AuthType: "NONE" }));
    await lambda.send(new AddPermissionCommand({
      FunctionName, StatementId: "public-url", Principal: "*",
      Action: "lambda:InvokeFunctionUrl", FunctionUrlAuthType: "NONE",
    }));
    await lambda.send(new AddPermissionCommand({
      FunctionName, StatementId: "public-url-invoke", Principal: "*",
      Action: "lambda:InvokeFunction", InvokedViaFunctionUrl: true,
    }));
    return FunctionUrl;
  },
);

console.log(`\n${STAGE}: ${url.value}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${STAGE} にデプロイしました\n${url.value}\n`);
}
