// 予算超過で止まったステージを再開する（STAGE 未指定なら全ステージ）
import { LambdaClient, DeleteFunctionConcurrencyCommand } from "@aws-sdk/client-lambda";
import { REGION, STAGES, names } from "./config.mjs";
import { attempt } from "./aws.mjs";

const lambda = new LambdaClient({ region: REGION });
for (const stage of process.env.STAGE ? [process.env.STAGE] : STAGES) {
  const FunctionName = names(stage).func;
  await attempt(`${FunctionName} 再開`, () => lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName })));
}
