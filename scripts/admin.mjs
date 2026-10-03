// 管理者によるグローバル削除（docs/09 M4a / 08 §2 §5 / 03 §4.2）
//
//   ★削除は論理削除。物理削除はしない（08 §5-6 の保全。30日は復旧できる）
//   ★何を・なぜ消したかを LOG# に残す。号（「削除の申出」第1条の1〜12）は必須
//   ★タグに投稿者という概念を置かないので、削除を投稿者に通知することはしない。
//     異議は誰でもメールで申し出られる（restore で戻す）
//   ★remove と mute は別物:
//       remove … 検索からもページからも消える。法的理由のときだけ（号が必須）
//       mute   … ページ上から見えなくなるが検索では出る。荒らし・ノイズ向け。記録は残る
//
//   使い方（STAGE と AWS 認証情報が要る。ローカル確認は DDB_ENDPOINT も）:
//     ★npm run は使わない。npm が --clause などを自分の設定として食べてしまう
//     ★SDK は aws login のセッションを更新できない。先に認証情報を環境変数へ出すこと:
//         eval "$(aws configure export-credentials --format env)"                 # bash
//         aws configure export-credentials --format powershell | iex              # PowerShell
//
//     STAGE=dev node scripts/admin.mjs recent           # 中身をまとめて眺める
//     STAGE=dev node scripts/admin.mjs show    <url>
//     STAGE=dev node scripts/admin.mjs remove  <url> <tag> --clause 3 --reason "本人の電話番号"
//     STAGE=dev node scripts/admin.mjs mute    <url> <tag> --reason "荒らし"   # 見えないが検索には出る
//     STAGE=dev node scripts/admin.mjs unmute  <url> <tag>
//     STAGE=dev node scripts/admin.mjs restore <url> <tag> --reason "異議が認められたため"
//     STAGE=dev node scripts/admin.mjs deny    tag|domain|url <値> [--reason ...]
//     STAGE=dev node scripts/admin.mjs undeny  tag|domain|url <値>
//     STAGE=dev node scripts/admin.mjs deny-list
import { readFileSync } from "node:fs";
import { STAGE, names } from "./config.mjs";
import { normalizeUrl } from "../src/normalize.mjs";
import { prepareTag } from "../src/tag.mjs";

// ★ store.mjs は読み込み時に TABLE_NAME を見て、無ければメモリ実装に落ちる。
//   そのまま import すると、削除したつもりで何も削除されない（「見つかりません」と言われる）。
//   ステージから表名を決めてから読み込むこと。順番が意味を持つので動的 import にしている
process.env.TABLE_NAME ??= names().table;
const store = await import("../src/store.mjs");
// tags.mjs も store.mjs を読むので、同じ理由で動的に読む（静的 import は巻き上げられて先に走る）
const { isDisplayable } = await import("../src/tags.mjs");

if (!process.env.TABLE_NAME) {
  console.error("TABLE_NAME を決められませんでした。STAGE を指定してください");
  process.exit(1);
}
// 「どこを触るのか」を必ず先に出す。取り違えて消すのが一番まずい
console.error(`[${STAGE}] ${process.env.TABLE_NAME}${process.env.DDB_ENDPOINT ? `（${process.env.DDB_ENDPOINT}）` : ""}`);

const RULES = JSON.parse(readFileSync(new URL("../src/data/norm-rules.json", import.meta.url), "utf8"));

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const [command, ...rest] = positional;

const locate = async (rawUrl, rawTag) => {
  const n = normalizeUrl(rawUrl, RULES);
  const hash = store.urlHash(n.url);

  const tag = rawTag ? prepareTag(rawTag) : null;
  return { url: n.url, hash, tag };
};

const die = (msg) => { console.error(msg); process.exit(1); };

// ページ上に見えているか。判定はサーバーと同じ関数を使う（ここで別実装すると必ずずれる）
// 使い方を出すだけで DynamoDB を叩かないよう、必要になってから読む
let CONFIG = null;
const life = async () => {
  CONFIG ??= await store.config();
  return { grace_days: CONFIG.display_grace_days, life_days: CONFIG.display_life_days };
};
const shownWith = (l) => (row) =>
  (row.status === "active" || row.status === "collapsed") && isDisplayable(row, l);

switch (command) {
  case "show": {
    const [rawUrl] = rest;
    if (!rawUrl) die("URL を指定してください");
    const { url, hash } = await locate(rawUrl);
    const rows = await store.tagsOfUrl(hash);
    const shown = shownWith(await life());
    console.log(`${url}\n  url_hash: ${hash}`);
    if (!rows.length) console.log("  （タグなし）");
    for (const r of rows) {
      console.log(`  - ${r.tag_text}  [${r.status}]${shown(r) ? "" : " 非表示"}  tag_id=${r.tag_id} 到達=${r.reach ?? 0}`);
    }
    break;
  }

  case "remove":
  case "quarantine": {
    const [rawUrl, rawTag] = rest;
    const clause = flag("clause");
    const reason = flag("reason");
    if (!rawUrl || !rawTag) die("URL と タグ を指定してください");
    // ★号を必須にする。「なんとなく消す」を仕組みとして禁じる（08 §2 は限定列挙）
    // npm run 経由だと npm が --clause を食べる。そこで止まらないよう理由を添える
    if (!clause) {
      die("--clause を指定してください（「削除の申出」第1条の 1〜12）\n"
        + "  ※ npm run ではなく `node scripts/admin.mjs ...` で実行してください（npm がフラグを食べます）");
    }
    if (!reason) die("--reason を指定してください（記録に残ります）");

    const { url, hash, tag } = await locate(rawUrl, rawTag);
    const before = await store.getTag(hash, tag.tag_id);
    if (!before) die("そのタグは見つかりません");

    const status = command === "remove" ? "removed" : "quarantined";
    await store.setTagStatus(hash, tag.tag_id, status);
    await store.putTakedownLog({
      action: status, url, url_hash: hash, tag: before.tag_text, tag_id: tag.tag_id,
      clause, reason, reporter: flag("from"),
    });
    const v = await store.denyVersion();
    console.log(`✓ ${status}: 「${before.tag_text}」 ${url}`);
    console.log(`  記録: LOG# に保存（第${clause}号 / ${reason}）`);
    console.log(`  検索からもページからも消えました。30日は restore で戻せます`);
    console.log(`  deny_version: ${v}`);
    break;
  }

  // 表示だけを止める。荒らし・ノイズ向け。法的削除ではないので号は要らない
  //   ★これは「見えないが検索には出る」状態。記録を消さずに実害（開いた人全員に見えること）だけ消す
  case "mute":
  case "unmute": {
    const [rawUrl, rawTag] = rest;
    if (!rawUrl || !rawTag) die("URL と タグ を指定してください");
    const reason = flag("reason");
    if (command === "mute" && !reason) die("--reason を指定してください（記録に残ります）");
    const { url, hash, tag } = await locate(rawUrl, rawTag);
    const before = await store.getTag(hash, tag.tag_id);
    if (!before) die("そのタグは見つかりません");
    const status = command === "mute" ? "muted" : "active";
    await store.setTagStatus(hash, tag.tag_id, status);
    await store.putTakedownLog({
      action: status === "muted" ? "muted" : "unmuted", url, url_hash: hash,
      tag: before.tag_text, tag_id: tag.tag_id, reason: reason ?? null,
    });
    console.log(`✓ ${status === "muted" ? "非表示" : "表示に戻した"}: 「${before.tag_text}」 ${url}`);
    console.log(status === "muted"
      ? "  ページ上からは見えなくなりました。検索では今までどおり出ます（記録は消えていません）"
      : "  ページ上に戻りました（表示寿命の範囲内なら）");
    break;
  }

  case "restore": {
    const [rawUrl, rawTag] = rest;
    if (!rawUrl || !rawTag) die("URL と タグ を指定してください");
    const { url, hash, tag } = await locate(rawUrl, rawTag);
    const before = await store.getTag(hash, tag.tag_id);
    if (!before) die("そのタグは見つかりません");
    await store.setTagStatus(hash, tag.tag_id, "active");
    await store.putTakedownLog({
      action: "restored", url, url_hash: hash, tag: before.tag_text, tag_id: tag.tag_id,
      reason: flag("reason", "異議申立ての認容"),
    });
    console.log(`✓ 復旧: 「${before.tag_text}」 ${url}`);
    break;
  }

  case "deny": {
    const [kind, value] = rest;
    if (!["tag", "domain", "url"].includes(kind)) die("deny tag|domain|url <値>");
    if (!value) die("値を指定してください");
    // タグは normalized_key を鍵にする（保存時と同じ形に揃える）
    const key = kind === "tag" ? prepareTag(value).normalized_key
      : kind === "url" ? store.urlHash(normalizeUrl(value, RULES).url)
      : value;
    const version = await store.addDeny(kind, key, { reason: flag("reason", "") });
    console.log(`✓ 禁止リストに追加: ${kind} = ${key}`);
    console.log(`  deny_version: ${version}（クライアントは次の設定取得でキャッシュを捨てます）`);
    break;
  }

  case "undeny": {
    const [kind, value] = rest;
    if (!["tag", "domain", "url"].includes(kind)) die("undeny tag|domain|url <値>");
    if (!value) die("値を指定してください");
    const key = kind === "tag" ? prepareTag(value).normalized_key
      : kind === "url" ? store.urlHash(normalizeUrl(value, RULES).url)
      : value;
    const version = await store.removeDeny(kind, key);
    console.log(`✓ 禁止リストから外した: ${kind} = ${key}`);
    console.log(`  deny_version: ${version}`);
    break;
  }

  case "recent": {
    // 中身を読める形で眺める（コンソールは pk/sk が生で出て読みにくい）
    const db = await store.backend();
    const rows = await db.scan(500);
    const shown = shownWith(await life());
    const when = (t) => new Date(t).toLocaleString("ja-JP");
    const by = (type) => rows.filter((r) => r.type === type);

    const tags = by("TAG").sort((a, b) => b.created_at - a.created_at);
    console.log(`
タグ（${tags.length}件。× = 削除済み / － = ページ上は非表示だが検索には出る）`);
    for (const t of tags) {
      // × = 検索からも消えている（法的削除） / － = ページ上は見えないが検索には出る
      const mark = store.HIDDEN_EVERYWHERE.includes(t.status) ? "×" : shown(t) ? " " : "－";
      console.log(`  ${mark} ${when(t.created_at)}  ${t.tag_text}`);
      console.log(`      ${t.url}`);
      console.log(`      ${t.status} / 到達 ${t.reach ?? 0}${t.reach_at ? `（最後 ${when(t.reach_at)}）` : ""}`);
    }

    const logs = by("LOG").sort((a, b) => b.ts - a.ts);
    if (logs.length) {
      console.log(`
削除・復旧の記録（${logs.length}件）`);
      for (const l of logs) {
        console.log(`  ${when(l.ts)}  ${l.action}  「${l.tag}」${l.clause ? ` 第${l.clause}号` : ""}  ${l.reason ?? ""}`);
      }
    }

    const plog = by("PLOG").sort((a, b) => b.ts - a.ts);
    if (plog.length) {
      console.log(`
投稿ログ（発信者情報・${plog.length}件。180日で自動削除）`);
      for (const p of plog.slice(0, 10)) console.log(`  ${when(p.ts)}  ${p.ip}  「${p.tag}」`);
    }

    const users = by("USR");
    const kpi = by("KPI");
    console.log(`
そのほか: 端末 ${users.length} / 日次集計 ${kpi.length}`);
    console.log(`表示寿命: 新着 ${(await life()).grace_days}日 / 到達から ${(await life()).life_days}日`);
    console.log(`URL数: ${rows.find((r) => r.pk === "STAT")?.n ?? 0} / deny_version: ${rows.find((r) => r.sk === "VERSION")?.deny_version ?? 0}`);
    break;
  }

  case "deny-list": {
    const db = await store.backend();
    const { items } = await db.query({ pk: "DENY" });
    // "VERSION" は世代カウンタで、禁止の中身ではない
    const entries = items.filter((i) => i.sk !== "VERSION");
    for (const i of entries) console.log(`  ${i.sk}  ${i.reason ?? ""}`);
    if (!entries.length) console.log("  （なし）");
    console.log(`  deny_version: ${items.find((i) => i.sk === "VERSION")?.deny_version ?? 0}`);
    break;
  }

  default:
    // 先頭のコメントから、使い方の行だけを抜き出して出す
    console.log(readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("//") && (l.includes("admin.mjs ") || l.includes("export-credentials")))
      .map((l) => l.replace(/^\/\/ {0,5}/, "  "))
      .join("\n"));
    process.exit(1);
}
