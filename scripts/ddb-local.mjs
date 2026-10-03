// DynamoDB Local にテーブルを作る（テスト用）
//   docker compose up -d のあとに実行される（npm test が自動で呼ぶ）
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { tableDefinition } from "./table.mjs";

const endpoint = process.env.DDB_ENDPOINT ?? "http://127.0.0.1:8000";
const TableName = process.env.TABLE_NAME ?? "doyu-test-main";

const ddb = new DynamoDBClient({
  endpoint,
  region: "ap-northeast-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

if (process.argv.includes("--reset")) {
  try {
    await ddb.send(new DeleteTableCommand({ TableName }));
  } catch (e) {
    if (e.name !== "ResourceNotFoundException") throw e;
  }
}

try {
  await ddb.send(new DescribeTableCommand({ TableName }));
  console.log(`= ${TableName} は既にあります`);
} catch (e) {
  if (e.name !== "ResourceNotFoundException") throw e;
  await ddb.send(new CreateTableCommand(tableDefinition(TableName, "dev")));
  console.log(`✓ ${TableName} を作成しました（${endpoint}）`);
}
