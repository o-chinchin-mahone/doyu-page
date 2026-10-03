// サーバー発行の HMAC トークン（docs/99 §3 D2）
//
//   匿名UUIDでの投稿は維持する（軸3）。防ぐのは「名乗りの偽装」だけ:
//   クライアントが自称する anon を信用せず、トークンから取り出した anon を使う。
//   これがないと、他人のIDを騙って投稿ログを汚したり、作成日時を詐称して
//   trust の判定（02 §3）をごまかしたりできる。
//
//   同じ鍵でページングカーソルにも署名する（docs/02 §7。探索枠や降格をスキップする偽造を防ぐ）。
import { createHmac, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";

const SECRET = process.env.TOKEN_SECRET || randomBytes(32).toString("hex");
if (!process.env.TOKEN_SECRET && process.env.STAGE && process.env.STAGE !== "local") {
  // 鍵が無くても動くが、コンテナが入れ替わると既存トークンが失効する
  console.warn("TOKEN_SECRET が未設定です（SSM /doyu/<stage>/token-secret を設定してください）");
}

export const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

export class TokenError extends Error {
  constructor(code) { super(code); this.name = "TokenError"; this.code = code; }
}

const sign = (payload) => createHmac("sha256", SECRET).update(payload).digest("base64url").slice(0, 32);

const equal = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** 新しい匿名IDを払い出す */
export const newAnon = () => randomUUID();

/** anon を封じたトークンを発行する */
export function issueToken(anon, now = Date.now()) {
  const exp = now + TOKEN_TTL_MS;
  const payload = `${anon}.${exp}`;
  return `v1.${payload}.${sign(payload)}`;
}

/** トークンを検証して anon を返す */
export function verifyToken(token, now = Date.now()) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new TokenError("token_malformed");
  const [, anon, exp, sig] = parts;
  if (!equal(sign(`${anon}.${exp}`), sig)) throw new TokenError("token_invalid");
  if (Number(exp) < now) throw new TokenError("token_expired");
  return anon;
}

/** ページングカーソル（中身は DynamoDB の LastEvaluatedKey） */
export function signCursor(key) {
  if (!key) return null;
  const body = Buffer.from(JSON.stringify(key)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyCursor(cursor) {
  if (!cursor) return null;
  const [body, sig] = String(cursor).split(".");
  if (!body || !sig || !equal(sign(body), sig)) throw new TokenError("cursor_invalid");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}
