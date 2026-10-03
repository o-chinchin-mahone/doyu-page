// 運営の操作の本体。コマンド（admin.mjs）と運用用ページ（admin-page.mjs）の両方がここを呼ぶ
//
//   ★store.mjs をここで静的に import しない。store.mjs は読み込み時に TABLE_NAME を見るので、
//     呼ぶ側が表名を決めてから動的に読み、createAdmin に渡す（理由は admin.mjs の冒頭）
//   ★処理を2か所に書かない。画面から消したときとコマンドで消したときで、
//     状態と記録（LOG#）が同じ形になること
import { readFileSync } from "node:fs";
import { normalizeUrl } from "../src/normalize.mjs";
import { prepareTag } from "../src/tag.mjs";

export const RULES = JSON.parse(readFileSync(new URL("../src/data/norm-rules.json", import.meta.url), "utf8"));

// 号の一覧は「削除の申出」のフォームから取る（ここに写しを持つと、文書を直したときにずれる）
export const CLAUSES = [...readFileSync(new URL("../src/legal/takedown.html", import.meta.url), "utf8")
  .matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)].map(([, n, label]) => ({ n, label }));

/** 号として通るのは 1〜12 だけ。通れば文字列（"3"）、だめなら null */
export const clauseOf = (raw) => {
  const s = String(raw ?? "").trim();
  return CLAUSES.some((c) => c.n === s) ? s : null;
};

/** 使い方の誤り・対象が無いなど、操作した人に文面をそのまま見せてよい失敗 */
export class AdminError extends Error {
  constructor(message) { super(message); this.name = "AdminError"; }
}

/**
 * 申出フォーム（src/legal/takedown.js）が作るメール本文から、対象を読み取る。
 *   ★純粋な関数にしておく。運用用ページはこの関数の中身をそのままブラウザへ配って使うので、
 *     外の変数や import を参照しないこと
 *   ★同じ見出しが2回出たら、先に出たほうを採る。本文の順番は URL・タグ・号・理由 で、
 *     理由は申出者が自由に書ける。理由の中に「対象URL: …」と書いて対象をすり替えられないようにする
 */
export function parseReport(text) {
  const FIELDS = {
    "対象URL": "url", "対象タグ": "tag", "該当する号": "clause",
    "理由": "reason", "申出者のお名前": "reporter", "権利者であることの説明": "proof",
  };
  const LONG = ["reason", "proof"]; // 複数行で書かれる欄
  const got = {};
  let head = "", cur = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    // 引用の印（"> "）と前後の空白を落とす。転送や返信の形で貼られても読めるように
    const line = raw.replace(/^[\s>]+/, "").trimEnd();
    const m = /^(対象URL|対象タグ|該当する号|理由|申出者のお名前|権利者であることの説明)\s*[:：]\s*(.*)$/.exec(line);
    if (m && !(FIELDS[m[1]] in got)) {
      cur = FIELDS[m[1]];
      got[cur] = m[2];
    } else if (cur && LONG.includes(cur)) {
      got[cur] += "\n" + line;
    } else if (!Object.keys(got).length) {
      head += line + "\n";
    }
  }
  const digits = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 本文に号が無ければ、件名（"[削除の申出] 3号 タグ"）からも探す
  const c = /^第?\s*(\d{1,2})\s*号?/.exec(digits(got.clause ?? "").trim())
    ?? /\[削除の申出\]\s*(\d{1,2})\s*号/.exec(digits(head));
  const n = c ? Number(c[1]) : 0;
  return {
    kind: head.includes("サイト全体へのタグ付けの停止") ? "domain" : "tag",
    // メールソフトが URL を <…> で囲むことがある
    url: (got.url ?? "").trim().replace(/^<(.*)>$/, "$1"),
    tag: (got.tag ?? "").trim(),
    clause: n >= 1 && n <= 12 ? String(n) : null,
    reason: (got.reason ?? "").trim(),
    reporter: (got.reporter ?? "").trim(),
  };
}

// store.mjs の ym と同じ形（UTC の YYYYMM）。LOG# の pk はこれで切られている
const ym = (t) => new Date(t).toISOString().slice(0, 7).replace("-", "");

/**
 * @param {object} deps.store          動的に読んだ src/store.mjs
 * @param {Function} deps.isDisplayable src/tags.mjs の isDisplayable（表示の判定はサーバーと同じ関数を使う）
 */
export function createAdmin({ store, isDisplayable }) {
  const locate = (rawUrl, rawTag) => {
    const n = normalizeUrl(rawUrl, RULES);
    const hash = store.urlHash(n.url);

    const tag = rawTag ? prepareTag(rawTag) : null;
    return { url: n.url, hash, tag };
  };

  // タグは normalized_key を鍵にする（保存時と同じ形に揃える）
  const denyKey = (kind, value) =>
    kind === "tag" ? prepareTag(value).normalized_key
      : kind === "url" ? store.urlHash(normalizeUrl(value, RULES).url)
      : value;

  // ページ上に見えているか。判定はサーバーと同じ関数を使う（ここで別実装すると必ずずれる）
  // 使い方を出すだけで DynamoDB を叩かないよう、必要になってから読む
  let CONFIG = null;
  const life = async () => {
    CONFIG ??= await store.config();
    return { grace_days: CONFIG.display_grace_days, life_days: CONFIG.display_life_days };
  };
  const shownWith = (l) => (row) =>
    (row.status === "active" || row.status === "collapsed") && isDisplayable(row, l);

  // 状態を変えて、記録を残す。ここが唯一の書き込み口
  //   from … いまの状態がこの中に無ければ止める（画面が古いまま押したときの取り違えを防ぐ）。
  //          コマンドは渡さない＝これまでどおり、どの状態からでも変えられる
  const change = async ({ hash, tag_id, url, from = null }, status, log) => {
    const before = await store.getTag(hash, tag_id);
    if (!before) throw new AdminError("そのタグは見つかりません");
    if (from && !from.includes(before.status)) {
      throw new AdminError("タグの状態が変わっています。読み込み直してください");
    }
    await store.setTagStatus(hash, tag_id, status);
    await store.putTakedownLog({
      url: url ?? before.url, url_hash: hash, tag: before.tag_text, tag_id, ...log,
    });
    return before;
  };

  /** 消す。検索からもページからも消える。法的理由のときだけ（号と理由が必須） */
  const remove = async ({ clause, reason, reporter = null, status = "removed", ...target }) => {
    // ★号を必須にする。「なんとなく消す」を仕組みとして禁じる（08 §2 は限定列挙）
    if (!clause) throw new AdminError("号を指定してください（「削除の申出」第1条の 1〜12）");
    if (!reason) throw new AdminError("理由を指定してください（記録に残ります）");
    const before = await change(target, status, { action: status, clause, reason, reporter });
    return { before, status, deny_version: await store.denyVersion() };
  };

  /** 隠す。ページ上から見えなくなるが検索には出る。荒らし・ノイズ向け。号は要らない */
  const mute = async ({ reason, ...target }) => {
    if (!reason) throw new AdminError("理由を指定してください（記録に残ります）");
    return { before: await change(target, "muted", { action: "muted", reason }) };
  };

  const unmute = async ({ reason = null, ...target }) =>
    ({ before: await change(target, "active", { action: "unmuted", reason: reason ?? null }) });

  /** 消したものを戻す */
  const restore = async ({ reason = null, ...target }) =>
    ({ before: await change(target, "active", { action: "restored", reason: reason || "異議申立ての認容" }) });

  /** そのページに付いているタグを全部消す。すでに消してあるものは触らない */
  const removeAll = async ({ hash, clause, reason, reporter = null }) => {
    if (!clause) throw new AdminError("号を指定してください（「削除の申出」第1条の 1〜12）");
    if (!reason) throw new AdminError("理由を指定してください（記録に残ります）");
    const rows = (await store.tagsOfUrl(hash)).filter((r) => !store.HIDDEN_EVERYWHERE.includes(r.status));
    for (const r of rows) await remove({ hash, tag_id: r.tag_id, clause, reason, reporter });
    return { count: rows.length };
  };

  const deny = async (kind, value, { reason = "" } = {}) => {
    const key = denyKey(kind, value);
    return { key, version: await store.addDeny(kind, key, { reason }) };
  };

  // 一覧から外すときは、保存されている鍵（URL ならハッシュ）をそのまま渡せる
  const undenyKey = async (kind, key) => ({ key, version: await store.removeDeny(kind, key) });
  const undeny = (kind, value) => undenyKey(kind, denyKey(kind, value));

  const KINDS = { TAG: "tag", DOM: "domain", URL: "url" };
  const denyList = async () => {
    const db = await store.backend();
    const { items } = await db.query({ pk: "DENY" });
    // "VERSION" は世代カウンタで、禁止の中身ではない
    const entries = items.filter((i) => i.sk !== "VERSION");
    return {
      items,
      entries: entries.map((i) => ({
        sk: i.sk, kind: KINDS[i.sk.slice(0, 3)], key: i.sk.slice(4),
        reason: i.reason ?? "", created_at: i.created_at ?? null,
      })),
      version: items.find((i) => i.sk === "VERSION")?.deny_version ?? 0,
    };
  };

  /**
   * 削除・復旧の記録（LOG#）を新しい順に読む。
   *   store に読む関数は無い（書くだけ）。pk が月ごと（LOG#YYYYMM）なので、今月からさかのぼって引く。
   *   全走査（scan）はしない。記録だけを、あるだけ読める
   */
  const logs = async ({ months = 12, now = Date.now() } = {}) => {
    const db = await store.backend();
    const d = new Date(now);
    const out = [];
    for (let i = 0; i < months; i++) {
      const pk = `LOG#${ym(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1))}`;
      let cursor = null;
      do {
        const r = await db.query({ pk, cursor });
        out.push(...r.items);
        cursor = r.cursor;
      } while (cursor);
    }
    return out.sort((a, b) => b.ts - a.ts);
  };

  // (ページ, タグ) ごとの、いちばん新しい「消した」記録。一覧に号を出すのに使う
  const lastRemoval = (allLogs) => {
    const map = new Map();
    for (const l of allLogs) {
      const k = `${l.url_hash}#${l.tag_id}`;
      if (store.HIDDEN_EVERYWHERE.includes(l.action) && !map.has(k)) map.set(k, l);
    }
    return map;
  };

  // 画面に出す1行。state は 表示中 / 期限切れ（検索には出る） / 隠している / 削除済み
  const view = (shown, removals) => (r) => ({
    url: r.url, url_hash: r.url_hash, tag_id: r.tag_id, tag_text: r.tag_text, title: r.title ?? null,
    created_at: r.created_at, reach: r.reach ?? 0, status: r.status,
    state: store.HIDDEN_EVERYWHERE.includes(r.status) ? "removed"
      : r.status === "muted" ? "muted" : shown(r) ? "shown" : "expired",
    clause: store.HIDDEN_EVERYWHERE.includes(r.status)
      ? removals.get(`${r.url_hash}#${r.tag_id}`)?.clause ?? null : null,
  });

  /** そのページに付いているタグの一覧（show 相当）。rawTag は申出にあったタグで、印を付けるのに使う */
  const pageTags = async (rawUrl, rawTag = null) => {
    const { url, hash } = locate(rawUrl);
    // 申出のタグが形式で弾かれる文字列（電話番号など）でも、一覧は出す
    let reported = null;
    try { reported = rawTag ? prepareTag(rawTag).tag_id : null; } catch { /* 印を付けないだけ */ }
    const rows = await store.tagsOfUrl(hash);
    const removals = lastRemoval(rows.some((r) => store.HIDDEN_EVERYWHERE.includes(r.status)) ? await logs() : []);
    const denied = await store.denyHits({ urlHashes: [hash] });
    return {
      url, url_hash: hash, reported_tag_id: reported, denied: denied.length > 0,
      tags: rows.sort((a, b) => b.created_at - a.created_at).map(view(shownWith(await life()), removals)),
    };
  };

  /**
   * 最近付いたタグ（recent 相当）と、消した記録。
   *   ★recent は admin.mjs と同じ全走査（先頭 limit 件）。件数が増えると新しい順の保証が無くなる
   */
  const overview = async ({ limit = 500 } = {}) => {
    const db = await store.backend();
    const rows = await db.scan(limit);
    const allLogs = await logs();
    const removals = lastRemoval(allLogs);
    const tags = rows.filter((r) => r.type === "TAG").sort((a, b) => b.created_at - a.created_at);

    // 消した記録。いまも消えたままのものだけ「戻す」を出せるよう、いまの状態を添える
    const removed = allLogs.filter((l) => store.HIDDEN_EVERYWHERE.includes(l.action)).slice(0, 200);
    const keys = [...new Map(removed.map((l) => [`${l.url_hash}#${l.tag_id}`,
      { pk: store.urlPk(l.url_hash), sk: store.tagSk(l.url_hash, l.tag_id) }])).values()];
    const now = new Map();
    for (let i = 0; i < keys.length; i += 100) { // BatchGet は1回100件まで
      for (const t of await db.batchGet(keys.slice(i, i + 100))) now.set(`${t.url_hash}#${t.tag_id}`, t.status);
    }
    return {
      scanned: rows.length, limit,
      tags: tags.map(view(shownWith(await life()), removals)),
      removals: removed.map((l) => ({
        ts: l.ts, url: l.url, url_hash: l.url_hash, tag: l.tag, tag_id: l.tag_id,
        clause: l.clause ?? null, reason: l.reason ?? "",
        // 記録のあとに戻して、また消したものは、新しいほうの記録にだけ「戻す」を出す
        restorable: store.HIDDEN_EVERYWHERE.includes(now.get(`${l.url_hash}#${l.tag_id}`))
          && removals.get(`${l.url_hash}#${l.tag_id}`) === l,
      })),
    };
  };

  return {
    locate, denyKey, life, shownWith,
    remove, mute, unmute, restore, removeAll, deny, undeny, undenyKey, denyList, logs, pageTags, overview,
  };
}
