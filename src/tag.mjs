// タグ正規化と tag_id ＋ 投稿時の機械フィルタ（docs/03 §3）
//
//   ★正規化は「全角半角を揃える（NFKC）・小文字にする・前後と連続の空白を詰める」だけ
//     （2026-09-23 の決定）。UTS#39 skeleton によるホモグリフ対策・bidi・Zalgo 判定は持たない。
//     帰結: キリル文字の "а" を混ぜた "cаt" は "cat" とは別のタグになる。
//   ★tag_id は後から変えられない（変えると既存データが全て死ぬ）。
import { createHash } from "node:crypto";
import { formatDenyReason } from "./format-deny.mjs";

export const MAX_LENGTH = 30;

export class TagError extends Error {
  constructor(code) { super(code); this.name = "TagError"; this.code = code; }
}

/** 表示用の原形から normalized_key を作る */
export function normalizeTag(raw) {
  const input = String(raw ?? "");
  if (/[\r\n\t]/.test(input)) throw new TagError("newline");

  const key = input.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

  if (!key) throw new TagError("empty");
  if ([...key].length > MAX_LENGTH) throw new TagError("too_long");
  // 機械フィルタ（docs/03 §3）。形式的なパターンだけを拒否し、内容の是非は判断しない
  const denied = formatDenyReason(key);
  if (denied) throw new TagError(denied);

  return key;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export function base32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// denylist・UNIQUE制約・GSI の PK をすべて normalized_key から作った同じ鍵で揃える
export const tagId = (normalizedKey) =>
  base32(createHash("sha256").update(normalizedKey).digest().subarray(0, 10));

/** 投稿経路で使う一括処理。display_form は原形（空白を詰めるだけ） */
export function prepareTag(raw) {
  const normalized_key = normalizeTag(raw);
  return {
    display_form: String(raw).replace(/\s+/gu, " ").trim(),
    normalized_key,
    tag_id: tagId(normalized_key),
  };
}
