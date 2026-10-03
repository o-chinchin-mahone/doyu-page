// タグ正規化・tag_id・投稿時の機械フィルタ（docs/03 §3）
//   正規化は NFKC（全角半角）＋小文字化＋空白の処理だけ（2026-09-23 の決定）
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareTag, normalizeTag, tagId, TagError, MAX_LENGTH } from "../src/tag.mjs";

// ★ tag_id は後から変えられない（変えると既存データが全て死ぬ）。
//   アルゴリズムを触ったらこのテストが落ちる。落ちたら「変えてよいのか」を先に考えること。
const GOLDEN_IDS = {
  "メヒカリ": "raxt2zfyy427t65h",
  "釣り": "ttgeev53s5jz5di7",
  "fishing": "wajavnczkwhtb635",
};

test("ゴールデン: tag_id は固定（変更＝既存データの全損）", () => {
  for (const [tag, id] of Object.entries(GOLDEN_IDS)) assert.equal(prepareTag(tag).tag_id, id, tag);
});

test("全角半角・大小文字・前後と連続の空白だけ揃える", () => {
  const ids = new Set(["メヒカリ", "  メヒカリ ", "ﾒﾋｶﾘ"].map((t) => prepareTag(t).tag_id));
  assert.equal(ids.size, 1);
  assert.equal(prepareTag("Fishing").tag_id, prepareTag("ｆｉｓｈｉｎｇ").tag_id);
  assert.equal(normalizeTag("a   b"), "a b");
});

test("ホモグリフは別タグになる（skeleton を持たない割り切り）", () => {
  // キリル文字の "а" を混ぜた "cаt" は "cat" とは別物として扱われる
  assert.notEqual(prepareTag("cаt").tag_id, prepareTag("cat").tag_id);
});

test("display_form と normalized_key を分けて持つ", () => {
  const p = prepareTag("  Mehikari  ");
  assert.equal(p.display_form, "Mehikari");
  assert.equal(p.normalized_key, "mehikari");
});

test("機械フィルタ: 形式的なパターンだけを拒否する（03 §3）", () => {
  const cases = {
    "090-1234-5678": "phone",
    "0312345678": "phone",
    "abc@example.com": "email",
    "https://example.com": "url",
    "example.com": "url",
    "123456789012": "my_number",
    "1234567": "digits",
  };
  for (const [input, code] of Object.entries(cases)) {
    assert.throws(() => normalizeTag(input), (e) => e instanceof TagError && e.code === code, input);
  }
});

test("改行・空・長すぎは拒否する", () => {
  const cases = {
    "a\nb": "newline",
    "": "empty",
    "   ": "empty",
    ["あ".repeat(MAX_LENGTH + 1)]: "too_long",
  };
  for (const [input, code] of Object.entries(cases)) {
    assert.throws(() => normalizeTag(input), (e) => e instanceof TagError && e.code === code, JSON.stringify(input));
  }
  assert.equal(normalizeTag("あ".repeat(MAX_LENGTH)).length, MAX_LENGTH);
});

test("tag_id は base32 16文字（sha256 の先頭10バイト）", () => {
  assert.match(prepareTag("メヒカリ").tag_id, /^[a-z2-7]{16}$/);
  assert.equal(tagId("メヒカリ"), prepareTag("メヒカリ").tag_id);
});
