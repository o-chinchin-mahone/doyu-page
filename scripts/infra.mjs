// ステージの土台を作る（管理者権限で手元から1回だけ実行）
//   DynamoDB テーブル（GSI×2・TTL） / SSM パラメータ / Lambda 実行ロール / デプロイロール（OIDC）
//   例: STAGE=dev GITHUB_REPO=o-chinchin-mahone/workspace GITHUB_SUB_PREFIX=... npm run infra
import {
  DynamoDBClient, CreateTableCommand, DescribeTableCommand, UpdateTimeToLiveCommand,
  DescribeTimeToLiveCommand, waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { SSMClient, PutParameterCommand, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  IAMClient, GetRoleCommand, CreateRoleCommand, AttachRolePolicyCommand, PutRolePolicyCommand, UpdateAssumeRolePolicyCommand,
  ListOpenIDConnectProvidersCommand, CreateOpenIDConnectProviderCommand,
} from "@aws-sdk/client-iam";
import { randomBytes } from "node:crypto";
import { REGION, APP, STAGE, GITHUB_REPO, names } from "./config.mjs";
import { accountId, ensure, trustPolicy, notFound } from "./aws.mjs";
import { tableDefinition, TTL_ATTRIBUTE } from "./table.mjs";

if (!GITHUB_REPO) throw new Error("GITHUB_REPO=owner/repo を指定してください");

const ddb = new DynamoDBClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const account = await accountId();
const n = names();
console.log(`アカウント ${account} / ステージ ${STAGE}`);

// 1. テーブル（シングルテーブル + GSI×2。GSI は後付けだと1本ずつしか足せないので最初から作る）
const table = await ensure(
  async () => (await ddb.send(new DescribeTableCommand({ TableName: n.table }))).Table,
  async () => (await ddb.send(new CreateTableCommand(tableDefinition(n.table, STAGE)))).TableDescription,
);
await waitUntilTableExists({ client: ddb, maxWaitTime: 300 }, { TableName: n.table });
console.log(`✓ テーブル ${n.table}`);

// 2. TTL（重複排除・到達バケット・レート制限・ログの自動回収）
const ttl = await ddb.send(new DescribeTimeToLiveCommand({ TableName: n.table }));
if (ttl.TimeToLiveDescription?.TimeToLiveStatus !== "ENABLED") {
  await ddb.send(new UpdateTimeToLiveCommand({
    TableName: n.table,
    TimeToLiveSpecification: { Enabled: true, AttributeName: TTL_ATTRIBUTE },
  }));
}
console.log(`✓ TTL (${TTL_ATTRIBUTE})`);

// 3. SSM パラメータ（許可IPと招待コード。stages.json に自宅IPを置かないため）
async function ensureParam(Name, initial) {
  try {
    const r = await ssm.send(new GetParameterCommand({ Name }));
    return r.Parameter.Value;
  } catch (e) {
    if (!notFound(e) && e.name !== "ParameterNotFound") throw e;
    await ssm.send(new PutParameterCommand({ Name, Value: initial, Type: "String", Overwrite: false }));
    return initial;
  }
}
// 許可IPは allow-me が書く。SSM は空文字を許さないので、ここでは作らない
//   （deploy.mjs は ParameterNotFound を "" として扱う = 全員許可）
const invite = await ensureParam(n.inviteCodeParam, randomBytes(16).toString("base64url"));
console.log(`✓ SSM ${n.inviteCodeParam}`);
console.log(`  招待コード: ${invite}`);
await ensureParam(n.tokenSecretParam, randomBytes(32).toString("hex"));
console.log(`✓ SSM ${n.tokenSecretParam}（投稿トークンの署名鍵。表示しない）`);
await ensureParam(n.originSecretParam, randomBytes(32).toString("hex"));
console.log(`✓ SSM ${n.originSecretParam}（Worker と共有する合言葉。表示しない）`);
// 直撃防御の有効フラグ。既定は "off"（Worker を立てるまでは素通しで動かす）。
// Worker 稼働後に `aws ssm put-parameter --name <this> --value on --overwrite` で有効化する。
await ensureParam(n.originEnforceParam, "off");
console.log(`✓ SSM ${n.originEnforceParam}（直撃防御。Worker 稼働後に on にする）`);

// GSI の射影は作成後に変更できない（索引を作り直すしかない）。定義とズレていたら気づけるようにする
const want = tableDefinition(n.table, STAGE).GlobalSecondaryIndexes;
for (const w of want) {
  const live = table.value.GlobalSecondaryIndexes?.find((g) => g.IndexName === w.IndexName);
  const missing = live && w.Projection.NonKeyAttributes
    .filter((a) => !(live.Projection.NonKeyAttributes ?? []).includes(a));
  if (missing?.length) {
    console.warn(`! ${w.IndexName} の射影に ${missing.join(", ")} がありません。`);
    console.warn("  射影は後から変えられません。データが無いうちにテーブルを作り直してください:");
    console.warn(`  STAGE=${STAGE} npm run destroy && STAGE=${STAGE} npm run infra`);
  }
}

// 4. Lambda 実行ロール（ログ + このテーブル + このステージの SSM だけ）
await ensure(
  () => iam.send(new GetRoleCommand({ RoleName: n.lambdaRole })),
  () => iam.send(new CreateRoleCommand({ RoleName: n.lambdaRole, AssumeRolePolicyDocument: trustPolicy("lambda.amazonaws.com") })),
);
await iam.send(new AttachRolePolicyCommand({
  RoleName: n.lambdaRole, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
}));
const tableArn = table.value.TableArn;
await iam.send(new PutRolePolicyCommand({
  RoleName: n.lambdaRole, PolicyName: "table-access",
  PolicyDocument: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
          "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
        ],
        Resource: [tableArn, `${tableArn}/index/*`],
      },
      {
        Effect: "Allow",
        Action: ["ssm:GetParameter"],
        Resource: `arn:aws:ssm:${REGION}:${account}:parameter/${APP}/${STAGE}/*`,
      },
    ],
  }),
}));
console.log(`✓ 実行ロール ${n.lambdaRole}`);

// 5. GitHub Actions の OIDC プロバイダ（アカウントに1つ）
const oidcUrl = "token.actions.githubusercontent.com";
const providers = (await iam.send(new ListOpenIDConnectProvidersCommand({}))).OpenIDConnectProviderList;
let providerArn = providers.find((p) => p.Arn.endsWith(`/${oidcUrl}`))?.Arn;
if (!providerArn) {
  providerArn = (await iam.send(new CreateOpenIDConnectProviderCommand({
    Url: `https://${oidcUrl}`, ClientIDList: ["sts.amazonaws.com"],
  }))).OpenIDConnectProviderArn;
}
console.log("✓ GitHub OIDC プロバイダ");

// 6. デプロイロール: dev は main ブランチ、prod は doyu/v* タグからだけ
const subPrefix = process.env.GITHUB_SUB_PREFIX ?? `repo:${GITHUB_REPO}`;
const subject = STAGE === "prod" ? `${subPrefix}:ref:refs/tags/${APP}/v*` : `${subPrefix}:ref:refs/heads/main`;
const deployTrust = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: { Federated: providerArn },
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: {
      StringEquals: { [`${oidcUrl}:aud`]: "sts.amazonaws.com" },
      StringLike: { [`${oidcUrl}:sub`]: subject },
    },
  }],
});
const deployRole = await ensure(
  () => iam.send(new GetRoleCommand({ RoleName: n.deployRole })),
  () => iam.send(new CreateRoleCommand({ RoleName: n.deployRole, AssumeRolePolicyDocument: deployTrust })),
);
if (!deployRole.created) {
  await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: n.deployRole, PolicyDocument: deployTrust }));
}
const funcArn = `arn:aws:lambda:${REGION}:${account}:function:${n.func}`;
await iam.send(new PutRolePolicyCommand({
  RoleName: n.deployRole, PolicyName: "deploy",
  PolicyDocument: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:CreateFunction",
          "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration",
          "lambda:GetFunctionUrlConfig", "lambda:CreateFunctionUrlConfig", "lambda:AddPermission",
          "lambda:InvokeFunction",
        ],
        Resource: funcArn,
      },
      { Effect: "Allow", Action: "iam:PassRole", Resource: `arn:aws:iam::${account}:role/${n.lambdaRole}` },
      // デプロイ時に許可IP・招待コードを読んで Lambda の環境変数に入れる
      {
        Effect: "Allow",
        Action: ["ssm:GetParameter"],
        Resource: `arn:aws:ssm:${REGION}:${account}:parameter/${APP}/${STAGE}/*`,
      },
    ],
  }),
}));
console.log(`✓ デプロイロール ${n.deployRole}（${subject}）`);
