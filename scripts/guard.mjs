// 月額予算 + 超過時に全ステージを自動停止する仕組みを作る（管理者権限で手元から実行、何度でもOK）
//   予算超過 → Budgets が SNS に通知 → 停止用 Lambda が各ステージの同時実行数を 0 にする
import AdmZip from "adm-zip";
import { BudgetsClient, CreateBudgetCommand, DeleteBudgetCommand } from "@aws-sdk/client-budgets";
import { SNSClient, CreateTopicCommand, SetTopicAttributesCommand, SubscribeCommand } from "@aws-sdk/client-sns";
import { IAMClient, GetRoleCommand, CreateRoleCommand, AttachRolePolicyCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  LambdaClient, GetFunctionCommand, CreateFunctionCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand,
  AddPermissionCommand, waitUntilFunctionActiveV2, waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda";
import {
  REGION, BUDGET_NAME, BUDGET_USD, ALERT_EMAIL, TOPIC_NAME, STOPPER_FUNCTION, STOPPER_ROLE, guardTargets,
} from "./config.mjs";
import { accountId, ensure, notFound, sleep, trustPolicy } from "./aws.mjs";

if (!ALERT_EMAIL) throw new Error("ALERT_EMAIL=通知先のメールアドレス を指定してください");

const budgets = new BudgetsClient({ region: "us-east-1" }); // Budgets は us-east-1 のみ
const sns = new SNSClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const account = await accountId();
// prod は「停止」ではなく「絞り込み」にする（docs/04 §8 / 09 M5）
//   無料運営を続ける以上、上限に当たっても止まらず遅くなるのが正しい。
//   Lambda には "関数名:同時実行数" の形で渡す
const guarded = guardTargets();
const targets = guarded.map((t) => `${t.func}:${t.limit}`);

// 1. SNS トピック（Budgets から publish できるようにする）
const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: TOPIC_NAME }));
await sns.send(new SetTopicAttributesCommand({
  TopicArn, AttributeName: "Policy",
  AttributeValue: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow", Principal: { Service: "budgets.amazonaws.com" }, Action: "SNS:Publish", Resource: TopicArn,
      Condition: { StringEquals: { "aws:SourceAccount": account } },
    }],
  }),
}));
console.log("✓ SNS トピック");

// 2. 停止用ロール（各ステージの同時実行数を変えることだけ許可）
const role = await ensure(
  () => iam.send(new GetRoleCommand({ RoleName: STOPPER_ROLE })),
  () => iam.send(new CreateRoleCommand({ RoleName: STOPPER_ROLE, AssumeRolePolicyDocument: trustPolicy("lambda.amazonaws.com") })),
);
await iam.send(new AttachRolePolicyCommand({
  RoleName: STOPPER_ROLE, PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
}));
await iam.send(new PutRolePolicyCommand({
  RoleName: STOPPER_ROLE, PolicyName: "stop-site",
  PolicyDocument: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow", Action: "lambda:PutFunctionConcurrency",
      // ★ 関数名だけ。同時実行数を付けた文字列を入れるとバージョン指定になって権限が効かない
      Resource: guarded.map((t) => `arn:aws:lambda:${REGION}:${account}:function:${t.func}`),
    }],
  }),
}));
console.log("✓ 停止用ロール");

// 3. 停止用 Lambda
const zip = new AdmZip();
zip.addFile("index.mjs", Buffer.from(`
import { LambdaClient, PutFunctionConcurrencyCommand } from "@aws-sdk/client-lambda";
const client = new LambdaClient({});
export async function handler(event) {
  console.log(JSON.stringify(event));
  for (const target of process.env.TARGETS.split(",")) {
    const [FunctionName, limit] = target.split(":");
    const ReservedConcurrentExecutions = Number(limit ?? 0);
    try {
      await client.send(new PutFunctionConcurrencyCommand({ FunctionName, ReservedConcurrentExecutions }));
      console.log(ReservedConcurrentExecutions === 0 ? "stopped" : "throttled", FunctionName, ReservedConcurrentExecutions);
    } catch (e) {
      // そのステージが今はデプロイされていないだけなら、止めるものが無いので問題ない
      if (e.name === "ResourceNotFoundException") { console.log("not deployed", FunctionName); continue; }
      // それ以外は握りつぶさない。ここが落ちると予算ガードが何も止めていないことになる
      console.error("FAILED to limit", FunctionName, e.name, e.message);
    }
  }
}
`));
const ZipFile = zip.toBuffer();
const Environment = { Variables: { TARGETS: targets.join(",") } };
const FunctionName = STOPPER_FUNCTION;

const fn = await ensure(
  () => lambda.send(new GetFunctionCommand({ FunctionName })),
  async () => {
    for (let i = 0; ; i++) {
      try {
        return await lambda.send(new CreateFunctionCommand({
          FunctionName, Runtime: "nodejs22.x", Handler: "index.handler", Role: role.value.Role.Arn,
          Code: { ZipFile }, Timeout: 30, Environment,
        }));
      } catch (e) {
        if (e.name === "InvalidParameterValueException" && i < 12) { await sleep(5000); continue; }
        throw e;
      }
    }
  },
);
const wait = () => waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName });
if (fn.created) {
  await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 120 }, { FunctionName });
  await lambda.send(new AddPermissionCommand({
    FunctionName, StatementId: "from-sns", Principal: "sns.amazonaws.com", Action: "lambda:InvokeFunction", SourceArn: TopicArn,
  }));
} else {
  await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName, Environment }));
  await wait();
  await lambda.send(new UpdateFunctionCodeCommand({ FunctionName, ZipFile }));
  await wait();
}
const stopperArn = `arn:aws:lambda:${REGION}:${account}:function:${FunctionName}`;
await sns.send(new SubscribeCommand({ TopicArn, Protocol: "lambda", Endpoint: stopperArn }));
console.log(`✓ 停止用 Lambda（対象: ${targets.join(", ")}）`);

// 4. 予算（作り直して設定を確実に反映）
try { await budgets.send(new DeleteBudgetCommand({ AccountId: account, BudgetName: BUDGET_NAME })); }
catch (e) { if (!notFound(e)) throw e; }

const email = { SubscriptionType: "EMAIL", Address: ALERT_EMAIL };
const notify = (NotificationType, Threshold, Subscribers) => ({
  Notification: { NotificationType, ComparisonOperator: "GREATER_THAN", Threshold, ThresholdType: "PERCENTAGE" },
  Subscribers,
});
await budgets.send(new CreateBudgetCommand({
  AccountId: account,
  Budget: {
    BudgetName: BUDGET_NAME, BudgetType: "COST", TimeUnit: "MONTHLY",
    BudgetLimit: { Amount: String(BUDGET_USD), Unit: "USD" },
    CostTypes: { IncludeCredit: false, IncludeRefund: false }, // クレジットで相殺される前の実利用額で判定
  },
  NotificationsWithSubscribers: [
    notify("ACTUAL", 50, [email]),
    notify("FORECASTED", 100, [email]),
    notify("ACTUAL", 100, [email, { SubscriptionType: "SNS", Address: TopicArn }]),
  ],
}));
console.log(`✓ 予算 $${BUDGET_USD}/月（${ALERT_EMAIL} に通知、超過で自動停止）`);
