// 形式だけで弾くパターン（docs/03 §3 / 05 §7.5）
//
//   ★サーバー（投稿時に保存を拒否）と拡張（表示前に落とす）で同じものを使う。
//     サーバーを通ったあとでも二重に落とすのは、第三者サイトの上にUGCを重ねる以上、
//     「表示してしまってから消す」では遅いため。
//   Node 専用APIを使わない（拡張にそのまま載せる）。
export const FORMAT_DENY = [
  ["phone", /0\d{1,4}-?\d{1,4}-?\d{4}/],
  ["phone", /\+81[-\d]{9,}/],
  ["email", /[^\s@]+@[^\s@]+\.[a-z]{2,}/i],
  ["url", /https?:\/\//i],
  ["url", /(^|[^\w])[\w-]+\.(com|net|org|jp|io|me|tv|page)([^\w]|$)/i],
  ["my_number", /\d{12}/],
  ["digits", /\d{7,}/], // 口座番号・連番。7桁以上の数字列はタグとして持たない
  ["postal_address", /\d{3}-?\d{4}\s*\S*[都道府県市区町村]/],
];

/** 当たったパターンの種類を返す。何も当たらなければ null */
export function formatDenyReason(text) {
  for (const [code, re] of FORMAT_DENY) if (re.test(text)) return code;
  return null;
}
