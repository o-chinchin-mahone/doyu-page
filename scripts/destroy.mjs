// ステージを丸ごと削除する（管理者権限で手元から実行）
//   STAGE=dev npm run destroy          … そのステージだけ
//   WITH_GUARD=1 STAGE=dev npm run destroy … 予算ガードも消す（全ステージ消すときの最後に）
import { DynamoDBClient, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { IAMClient, DeleteRoleCommand, DetachRolePolicyCommand, DeleteRolePolicyCommand } from "@aws-sdk/client-iam";
import { LambdaClient, DeleteFunctionCommand } from "@aws-sdk/client-lambda";
import { BudgetsClient, DeleteBudgetCommand } from "@aws-sdk/client-budgets";
import { SNSClient, DeleteTopicCommand } from "@aws-sdk/client-sns";
import { REGION, STAGE, names, BUDGET_NAME, TOPIC_NAME, STOPPER_FUNCTION, STOPPER_ROLE } from "./config.mjs";
import { accountId, attempt } from "./aws.mjs";

const lambda = new LambdaClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const n = names();
const BASIC = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";

async function deleteRole(RoleName, inlinePolicy, managed) {
  await attempt(`${RoleName} ポリシー削除`, () => iam.send(new DeleteRolePolicyCommand({ RoleName, PolicyName: inlinePolicy })));
  if (managed) await attempt(`${RoleName} 管理ポリシー切り離し`, () => iam.send(new DetachRolePolicyCommand({ RoleName, PolicyArn: managed })));
  await attempt(`${RoleName} 削除`, () => iam.send(new DeleteRoleCommand({ RoleName })));
}

console.log(`ステージ ${STAGE} を削除します`);
await attempt(`${n.func} 削除`, () => lambda.send(new DeleteFunctionCommand({ FunctionName: n.func })));
await deleteRole(n.lambdaRole, "table-access", BASIC);
await deleteRole(n.deployRole, "deploy");
await attempt(`${n.table} 削除`, () => ddb.send(new DeleteTableCommand({ TableName: n.table })));

if (process.env.WITH_GUARD) {
  const account = await accountId();
  await attempt("予算削除", () => new BudgetsClient({ region: "us-east-1" }).send(new DeleteBudgetCommand({ AccountId: account, BudgetName: BUDGET_NAME })));
  await attempt("SNS トピック削除", () => new SNSClient({ region: REGION }).send(new DeleteTopicCommand({ TopicArn: `arn:aws:sns:${REGION}:${account}:${TOPIC_NAME}` })));
  await attempt(`${STOPPER_FUNCTION} 削除`, () => lambda.send(new DeleteFunctionCommand({ FunctionName: STOPPER_FUNCTION })));
  await deleteRole(STOPPER_ROLE, "stop-site", BASIC);
}
