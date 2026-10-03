// Public Suffix List から ICANN セクションだけを抜き出して src/data/psl.json を作る
//   実行時にダウンロードしない（docs/05 §7.4: リモートコード禁止。データも同梱する）
//   更新は年1回程度でよい: node scripts/gen-psl.mjs
import { writeFile } from "node:fs/promises";

const URL_PSL = "https://publicsuffix.org/list/public_suffix_list.dat";
const res = await fetch(URL_PSL);
if (!res.ok) throw new Error(`${URL_PSL} → ${res.status}`);
const text = await res.text();

// プライベートセクション（github.io / blogspot.com 等）は含めない。
// 本サービスの base_domain は「サイトの単位」なので、user.github.io は github.io に寄せてよい。
const icann = text.split("// ===END ICANN DOMAINS===")[0];
const rules = icann
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("//"));

const version = new Date().toISOString().slice(0, 10);
await writeFile(
  new URL("../src/data/psl.json", import.meta.url),
  `${JSON.stringify({ version, source: URL_PSL, rules: rules.join("\n") })}\n`,
);
console.log(`✓ src/data/psl.json  ${rules.length} ルール（ICANN セクションのみ・${version}）`);
