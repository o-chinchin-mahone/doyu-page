export const REGION = process.env.AWS_REGION || "ap-northeast-1"; // 東京
export const APP = "doyu";
export const GITHUB_REPO = process.env.GITHUB_REPO; // "owner/repo"（infra.mjs でのみ使用）

export const STAGES = ["dev", "prod"];
export const STAGE = process.env.STAGE || "dev";
if (!STAGES.includes(STAGE)) throw new Error(`STAGE は ${STAGES.join(" / ")} のどれか: ${STAGE}`);

// 拡張ID（M0 決定5: ローカル生成の鍵ペアで固定。npm run gen-ext-key で表示される）
export const EXTENSION_ID = "fladmnjffgaplkjhjnhfgifbmcdcoldj";

export const names = (stage = STAGE) => ({
  table: `${APP}-${stage}-main`,
  lambdaRole: `${APP}-${stage}-lambda-role`,
  deployRole: `${APP}-deploy-${stage}`,
  func: `${APP}-${stage}`,
  // 許可IPは stages.json ではなく SSM に置く（M0 決定4: 自宅IPを公開履歴に残さない）
  allowedIpsParam: `/${APP}/${stage}/allowed-ips`,
  inviteCodeParam: `/${APP}/${stage}/invite-code`,
  // 投稿トークン（名乗りの偽装防止）とページングカーソルの署名鍵。docs/99 §3 D2
  tokenSecretParam: `/${APP}/${stage}/token-secret`,
  // Cloudflare の Worker と共有する合言葉。Function URL 直撃を塞ぐ（docs/09 M5）
  originSecretParam: `/${APP}/${stage}/origin-secret`,
  // 直撃防御を有効にするか（"on"/"off"）。★SSM を正とする＝CI デプロイでも消えない。
  //   Worker を立てて ORIGIN_SECRET を wrangler へ入れたら "on" にする。
  //   これが無いと、有効化しても次の `npm run deploy`（CI）で ORIGIN_SECRET が空に戻り
  //   Function URL 直撃が黙って再開通する（deploy.mjs 参照）
  originEnforceParam: `/${APP}/${stage}/origin-enforce`,
});

// 容量配分（M0 決定3）。25 WCU / 25 RCU はアカウント合計。RCU 側が先に枯れる
export const CAPACITY = {
  dev: { table: { r: 2, w: 2 }, gsi1: { r: 1, w: 1 }, gsi2: { r: 1, w: 1 } },
  prod: { table: { r: 12, w: 8 }, gsi1: { r: 2, w: 3 }, gsi2: { r: 1, w: 2 } },
};

// アカウント全体の予算ガード
// 稼働中のバージョンに対応するソースの入手先を利用者に示す（/source）
export const SOURCE_URL = process.env.SOURCE_URL || "https://github.com/o-chinchin-mahone/doyu-page";
export const ABUSE_EMAIL = "abuse@doyu.page";

export const BUDGET_NAME = `${APP}-monthly`;
export const BUDGET_USD = 1;
export const ALERT_EMAIL = process.env.ALERT_EMAIL; // 予算超過の通知先（guard.mjs でのみ使用）
export const TOPIC_NAME = `${APP}-budget-alert`;
export const STOPPER_FUNCTION = `${APP}-stopper`;
export const STOPPER_ROLE = `${APP}-stopper-role`;
// prod は停止せず絞る（09 M5 / 04 §8）。dev は 0 で止めてよい
export const GUARD_CONCURRENCY = { dev: 0, prod: 5 };

// 予算超過時に絞る対象。★ 関数名と同時実行数を混ぜた文字列から IAM の Resource を作らないこと。
//   "doyu-dev:0" を ARN に埋めると function:doyu-dev:0 になり、これは「バージョン0」を指す別物。
//   PutFunctionConcurrency はバージョン指定できないので、権限が一致せず黙って AccessDenied になる
export const guardTargets = (stages = STAGES) =>
  stages.map((stage) => ({ stage, func: names(stage).func, limit: GUARD_CONCURRENCY[stage] ?? 0 }));
