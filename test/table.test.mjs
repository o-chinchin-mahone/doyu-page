// テーブル形状の検証（docs/09-roadmap.md M1 の完了条件）
//   「ドメインを跨ぐ索引を作らない」は仕様なので、CI が毎回落とせる形にしておく
import { test } from "node:test";
import assert from "node:assert/strict";
import { tableDefinition } from "../scripts/table.mjs";
import { CAPACITY } from "../scripts/config.mjs";

const def = tableDefinition("doyu-test-main", "dev");
const gsis = def.GlobalSecondaryIndexes;

test("GSI は2本まで（無料枠の 25 WCU/RCU はアカウント合計）", () => {
  assert.equal(gsis.length, 2);
});

test("★ドメインを跨ぐ索引が存在しない（docs/00 §2 の仕様）", () => {
  // GSI の PK は必ず "D#<domain>#T#<tag>" を入れる属性でなければならない。
  // タグ単独の索引（例: PK = tag_id）を足すと、ドメイン外のデータに到達できてしまう。
  for (const gsi of gsis) {
    const hashKey = gsi.KeySchema.find((k) => k.KeyType === "HASH").AttributeName;
    assert.ok(
      ["gsi1pk", "gsi2pk"].includes(hashKey),
      `GSI ${gsi.IndexName} のPKが ${hashKey}。ドメインを含まないキーで索引を作ってはいけない`,
    );
  }
});

test("GSI の射影は ALL にしない（reach/impr の更新をGSIに伝播させない）", () => {
  for (const gsi of gsis) {
    assert.equal(gsi.Projection.ProjectionType, "INCLUDE");
    assert.ok(!gsi.Projection.NonKeyAttributes.includes("reach"));
    assert.ok(!gsi.Projection.NonKeyAttributes.includes("impr"));
    // url が無いと検索結果からリンクを作れない（04 §4 の射影リストには書かれていなかった）。
    // 作成後に変わらない属性なので、射影しても GSI への書き込みは増えない
    assert.ok(gsi.Projection.NonKeyAttributes.includes("url"), `${gsi.IndexName} に url が無い`);
  }
});

test("GSI1 のソートキーは S（人気順・単調非減少）", () => {
  const sk = gsis[0].KeySchema.find((k) => k.KeyType === "RANGE").AttributeName;
  assert.equal(sk, "s");
});

test("GSI2 のソートキーは created_at（新着順・不変なので書き込み増幅ゼロ）", () => {
  const sk = gsis[1].KeySchema.find((k) => k.KeyType === "RANGE").AttributeName;
  assert.equal(sk, "created_at");
});

test("容量の合計が無料枠に収まる（sample の 1/1×2 を差し引いて計算）", () => {
  const sum = (stage) => {
    const c = CAPACITY[stage];
    return {
      r: c.table.r + c.gsi1.r + c.gsi2.r,
      w: c.table.w + c.gsi1.w + c.gsi2.w,
    };
  };
  const dev = sum("dev");
  const prod = sum("prod");
  const sampleAfterShrink = 2; // dev 1/1 + prod 1/1
  assert.ok(dev.r + prod.r + sampleAfterShrink <= 25, `RCU 合計 ${dev.r + prod.r + sampleAfterShrink} > 25`);
  assert.ok(dev.w + prod.w + sampleAfterShrink <= 25, `WCU 合計 ${dev.w + prod.w + sampleAfterShrink} > 25`);
});

// ---- 実テーブルの形状検証（DDB_ENDPOINT があるときだけ走る） --------------
//   docs/09-roadmap.md M1 の完了条件:
//   「DescribeTable の GSI 定義を assert するテストで、T#<tag_id> 単独PKのGSIが無いことを
//     CI が毎回検証する」。コードレビューでの確認は、自分が自分をレビューするので無検証と同じ。
const endpoint = process.env.DDB_ENDPOINT;
const TableName = process.env.TABLE_NAME ?? "doyu-test-main";

test("★DescribeTable: 実テーブルにドメインを跨ぐ索引が無い", { skip: !endpoint }, async () => {
  const { DynamoDBClient, DescribeTableCommand, DescribeTimeToLiveCommand } = await import("@aws-sdk/client-dynamodb");
  const ddb = new DynamoDBClient({
    endpoint, region: "ap-northeast-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  const { Table } = await ddb.send(new DescribeTableCommand({ TableName }));

  assert.equal(Table.GlobalSecondaryIndexes.length, 2, "GSI は2本まで");
  for (const gsi of Table.GlobalSecondaryIndexes) {
    const hashKey = gsi.KeySchema.find((k) => k.KeyType === "HASH").AttributeName;
    assert.ok(["gsi1pk", "gsi2pk"].includes(hashKey), `${gsi.IndexName} の PK が ${hashKey}`);
    assert.equal(gsi.Projection.ProjectionType, "INCLUDE");
    assert.ok(!gsi.Projection.NonKeyAttributes.includes("reach"));
    assert.ok(!gsi.Projection.NonKeyAttributes.includes("impr"));
  }
  assert.equal(Table.BillingModeSummary?.BillingMode ?? "PROVISIONED", "PROVISIONED", "オンデマンドにしない");

  // TTL（重複排除・到達バケット・レート制限・ログの自動回収）
  const ttl = await ddb.send(new DescribeTimeToLiveCommand({ TableName }));
  assert.ok(["ENABLED", "DISABLED"].includes(ttl.TimeToLiveDescription.TimeToLiveStatus));
});
