// テーブル定義（infra.mjs と DynamoDB Local の両方から使う。定義を1箇所に持つ）
//   設計: docs/04-architecture.md §3, §4
import { CAPACITY } from "./config.mjs";

// GSI は最大2本（無料枠の 25 WCU/RCU はアカウント合計で、GSI も独立に消費するため）
//   GSI1 = 人気順（SK = S。collapsed は gsi1pk を "...#C" に書き換えて兄弟パーティションへ）
//   GSI2 = 新着順（SK = created_at）
//   どちらも PK は "D#<base_domain>#T#<tag_id>" で、ドメインを跨ぐ索引は作らない（docs/00 §2 の仕様）
export const tableDefinition = (TableName, stage = "dev") => {
  const cap = CAPACITY[stage] ?? CAPACITY.dev;
  return {
    TableName,
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      { AttributeName: "gsi1pk", AttributeType: "S" },
      { AttributeName: "s", AttributeType: "N" },
      { AttributeName: "gsi2pk", AttributeType: "S" },
      { AttributeName: "created_at", AttributeType: "N" },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: cap.table.r, WriteCapacityUnits: cap.table.w },
    GlobalSecondaryIndexes: [
      {
        IndexName: "gsi1",
        KeySchema: [
          { AttributeName: "gsi1pk", KeyType: "HASH" },
          { AttributeName: "s", KeyType: "RANGE" },
        ],
        // ALL にすると reach/impr の更新まで GSI に伝播して書き込みが増える（04 §4）。
        // url は射影する: 検索結果のリンクを作るのに要り、作成後に変わらないので書き込みは増えない
        Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["tag_text", "created_at", "title", "status", "url"] },
        ProvisionedThroughput: { ReadCapacityUnits: cap.gsi1.r, WriteCapacityUnits: cap.gsi1.w },
      },
      {
        IndexName: "gsi2",
        KeySchema: [
          { AttributeName: "gsi2pk", KeyType: "HASH" },
          { AttributeName: "created_at", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["tag_text", "title", "status", "url"] },
        ProvisionedThroughput: { ReadCapacityUnits: cap.gsi2.r, WriteCapacityUnits: cap.gsi2.w },
      },
    ],
  };
};

// TTL は重複排除 / 到達バケット / レート制限 / ログの自動回収に使う（04 §5）
export const TTL_ATTRIBUTE = "ttl";
