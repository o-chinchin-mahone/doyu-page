// M1 最小データ経路: 「タグを付ける／見える／ドメイン内で引ける」の本体
//   docs/09-roadmap.md M1 / 04 §3 §6 / 05 §4 §5 / 01 §3 / 02 §8 / 03 §3
import { readFileSync } from "node:fs";
import * as store from "./store.mjs";
import { normalizeUrl, NormalizeError } from "./normalize.mjs";
import { prepareTag, TagError } from "./tag.mjs";
import { formatDenyReason } from "./format-deny.mjs";
import { assertPostable, BlockedUrlError } from "./blocklist.mjs";
import { verifyPublic, PublicityError } from "./publicity.mjs";
import { baseDomain } from "./psl.mjs";

export const RULES = JSON.parse(readFileSync(new URL("./data/norm-rules.json", import.meta.url), "utf8"));

// レート制限（01 §3）。IPでは数えない（CGNATで巻き添えが出る）
//   日次上限は置かない。匿名IDは /v1/hello で無制限に取れるので、取り直せば回避でき、
//   真面目な利用者だけを縛ることになる。
//   持つのは「一瞬の連投を止める」分あたりの上限と、1URLあたりの上限だけ。
//   連投そのものへの答えは到達数による埋没（02 §3）に寄せる
export const LIMITS = {
  perMinute: 5,
  perUrlPerPoster: 10,
  // 同じ (URL, タグ) への到達は、この秒数に1回までしか数えない。
  //   到達は無認証で、人気順の入力でもある（02 §6）。連打で順位と表示寿命を積めないようにする。
  //   誰が送ったかは見ない＝IPも匿名IDも保存しない。数えなかった分は書き込みも起きない
  reachIntervalSec: 10,
  // KPI は正規の利用なら1日1ドメイン1件程度。溜めた分のまとめ送りを通せる幅だけ持たせる
  kpiPerMinute: 30,
  // 投稿バースト（01 §5）。同じドメインへ windowMin 分のうちにこの件数を超えたら、freezeMin 分だけ投稿を止める。
  //   perId は分あたりの上限（5件×10分＝50件）の手前。手で付けていてまず届かない速さだけを拾う。
  //   perNet は同じ /24（IPv6 は /48）の合計。携帯回線は大勢で1つのIPを共有するので、IDよりずっと緩くする
  burst: { windowMin: 10, perId: 40, perNet: 200, freezeMin: 30 },
};

// IPの上位だけを取り出す（/24・IPv6 は /48）。バーストの集計にだけ使い、IPそのものは鍵にしない
export function netOf(ip) {
  if (typeof ip !== "string" || !ip) return null;
  if (ip.includes(".") && !ip.includes(":")) {
    const p = ip.split(".");
    return p.length === 4 ? p.slice(0, 3).join(".") : null;
  }
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  return groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, "").toLowerCase()).join(":");
}

export class ApiError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; Object.assign(this, extra); }
}

/** GET /v1/params — 前置長・正規化バージョン・禁止リスト世代をクライアントに配る */
export async function getParams() {
  const deny_version = await store.denyVersion();
  return {
    norm_v: RULES.norm_v,
    // url_count は返さない。クライアントは使わず、収録件数は運営側の数字なので
    //   無認証の経路で配る理由が無い。必要なら scripts/admin.mjs で見る
    // 読み取りは URL のハッシュそのもので引く。総当たりできない代わりに、
    //   サーバーは「タグが付いているページを見た」ことを知る。
    //   隠していないので k も privacy_mode も名乗らない（docs/05 と PP を参照）
    read_key: "url_hash",
    deny_version,
  };
}

/**
 * 表示寿命（docs/03 §2 の陳腐化）。
 *
 *   付いた直後は grace 日だけ必ず表示する（新しいタグに露出の機会を与える）。
 *   そのあとは、最後の到達から life 日だけ表示する。到達が無いまま grace を過ぎたタグは
 *   **ページ上から見えなくなるが、検索では出る**。荒らしタグはここで黙って沈む。
 *
 *   ★誰もクリックしない良いタグも同じように沈む。これは承知の上の設計で、
 *     だから「検索では出る＝記録は残る」を絶対に崩さない（消えるのは法的削除のときだけ）
 *   ★判定は読み取り時の計算だけで済む。集計の書き込みも cron も追加の読み取りも要らない
 */
export const isDisplayable = (row, { grace_days, life_days }, now = Date.now()) => {
  const day = 86400_000;
  if (now - (row.created_at ?? 0) < grace_days * day) return true;
  return now - (row.reach_at ?? 0) < life_days * day;
};

/**
 * GET /v1/tags?hash=... — そのURLに付いているタグ（04 §7）
 *   引くには URL を知っている必要がある。ハッシュは逆算できないので、
 *   鍵を順に数えて全件を持ち出すことができない
 *   読み取りは完全無認証・無Cookieで、IPも見ない
 */
export async function readTagsOfUrl(hash, now = Date.now()) {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new ApiError(400, "bad_hash");
  const { display_grace_days, display_life_days } = await store.config();
  const rows = await store.tagsOfUrl(hash);
  const life = { grace_days: display_grace_days, life_days: display_life_days };
  return rows
    // ★表示されるのは active / collapsed だけ。muted と寿命切れは「検索には出るが見えない」
    .filter((r) => r.status === "active" || r.status === "collapsed")
    .filter((r) => isDisplayable(r, life, now))
    // ★形式フィルタ（電話番号・メール等。05 §7.5）は投稿時にも掛けているが、ここでも掛ける。
    //   拡張側だけで落とすと、隠したはずの文字列が読み取りの応答に乗ってしまう
    .filter((r) => !formatDenyReason(r.tag_text))
    .map((r) => ({
      url_hash: r.url_hash,
      tag_id: r.tag_id,
      tag_text: r.tag_text,
      base_domain: r.base_domain,
      status: r.status,
      reach: r.reach ?? 0,
      created_at: r.created_at,
    })); // ★ url / ip / 投稿元の鍵は返さない
}

/**
 * ドメイン内検索。
 *   order=newest  … 付いた順（既定）。降格が効かない面なので、既定タブは
 *                   ここに探索枠を混ぜる想定（02 §4.1。探索枠は未実装）
 *   order=popular … 到達数の時間減衰スコア S の降順（02 §6）。
 *                   ★未到達タグは GSI1 に載らないので、ここには出てこない
 */
export const ORDERS = ["newest", "popular"];

export async function search({ domain, tag, cursor = null, limit = 20, order = "newest" }) {
  if (!domain || !tag) throw new ApiError(400, "domain_and_tag_required");
  if (!ORDERS.includes(order)) throw new ApiError(400, "bad_order", { allowed: ORDERS });
  const base = baseDomain(domain);
  if (!base) throw new ApiError(400, "bad_domain");
  let prepared;
  try { prepared = prepareTag(tag); } catch (e) { throw new ApiError(400, e.code ?? "bad_tag"); }

  const opts = { limit: Math.min(limit, 50), cursor };
  const r = order === "popular"
    ? await store.searchPopular(base, prepared.tag_id, opts)
    : await store.searchNewest(base, prepared.tag_id, opts);

  return {
    domain: base,
    tag: prepared.normalized_key,
    tag_id: prepared.tag_id,
    order,
    items: r.items.map((i) => ({
      url: i.url,
      // GSI には url_hash を射影していないが、ベーステーブルの PK は常に載るので取り出せる
      url_hash: String(i.pk).slice(2), // "U#<url_hash>"
      title: i.title ?? null,
      tag_text: i.tag_text,
      created_at: i.created_at,
    })),
    cursor: r.cursor,
  };
}

// クライアントが送ってくるタイトルは他人にも見えるテキストなので、形だけ整えて受ける
//   （内容の真偽は判断しない。偽物はタグと同じく通報・削除の経路で扱う）
//
//   ★120 は見た目ではなく容量で決まっている。タグのアイテムは title 抜きで約 570 バイトで、
//     DynamoDB は 1 WCU = 1KB。日本語 200 文字（≒600バイト）だと 1.17KB になり、
//     本体も GSI2（title を射影している）も 2 WCU 食う ＝ 投稿の持続上限が半分になる。
//     120 文字（≒360バイト）なら約 0.93KB で 1 WCU に収まる。
//     04 §8 の容量計算はこれを前提にしている。増やすなら GSI2 の WCU も一緒に見直すこと
export const MAX_TITLE = 120;
const sanitizeTitle = (raw) => {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  return t || null;
};

const rejectAs = (e) => {
  if (e instanceof NormalizeError) return new ApiError(400, `url_${e.code}`);
  if (e instanceof BlockedUrlError) return new ApiError(400, `url_${e.code}`);
  if (e instanceof TagError) return new ApiError(400, `tag_${e.code}`);
  if (e instanceof PublicityError) return new ApiError(400, `not_public_${e.code}`);
  return e;
};

/**
 * POST /v1/tags — タグを付ける
 *   url_id（url_hash）は必ずサーバーが算出する（クライアントに計算させると
 *   偽装して別URLのタグを汚染できる。04 §3）
 *
 * @param {boolean} [opts.enforceLimits] 既定 true。false にできるのは
 *   **公開前のシードタグ投入（seed/import.mjs）だけ**。API 経路からは絶対に渡さない
 *   （渡すと1つの端末鍵から無制限に書ける）。レート制限と 1URL あたりの上限を飛ばす。
 *   正規化・ブロックリスト・機械フィルタ・禁止リスト・重複判定は飛ばさない。
 * @param {object[]} [opts.existingTags] そのURLに既に付いているタグ。渡すと store.tagsOfUrl を
 *   呼ばない。**同じURLへ連続して付ける一括投入のためだけ**の抜け道。
 *   API 経路からは渡さない（古い一覧で重複判定すると二重に見える）。
 */
export async function postTag({ url, tag, anon, title: clientTitle = null, ip = null, ua = null, event_id = null, now = Date.now(), verify = verifyPublic, enforceLimits = true, existingTags = null }) {
  if (!url || !tag) throw new ApiError(400, "url_and_tag_required");

  // 1) 正規化 → 2) 書き込み経路のブロックリスト → 3) タグ正規化と機械フィルタ
  let normalized, prepared;
  try {
    normalized = normalizeUrl(url, RULES);
    assertPostable(url);
    prepared = prepareTag(tag);
  } catch (e) { throw rejectAs(e); }

  // 4) レート制限（高価な公開性検証の前に落とす）
  if (enforceLimits) {
    // touchUser は残す。作成日時はランキングの重み付け（02 §3 の trust）で使う
    await store.touchUser(anon, now);
    const { minute } = await store.bumpRateLimit(anon, now);
    if (minute > LIMITS.perMinute) throw new ApiError(429, "rate_minute", { retry_after: 60 });

    // バースト検知。凍結中なら公開性検証（外部アクセス）より前に落とす
    const domain = baseDomain(normalized.host);
    const net = netOf(ip);
    const whos = [[`A#${anon}`, LIMITS.burst.perId], ...(net ? [[`N#${net}`, LIMITS.burst.perNet]] : [])];
    const until = await store.frozenUntil(whos.map(([w]) => w), now);
    if (until) throw new ApiError(429, "burst_frozen", { retry_after: Math.ceil((until - now) / 1000) });
    if (domain) {
      const windowMs = LIMITS.burst.windowMin * 60_000;
      for (const [who, limit] of whos) {
        if (await store.bumpBurst(who, domain, { windowMs, now }) > limit) {
          const frozen = now + LIMITS.burst.freezeMin * 60_000;
          await store.freeze(who, frozen);
          throw new ApiError(429, "burst_frozen", { retry_after: LIMITS.burst.freezeMin * 60 });
        }
      }
    }
  }

  // 5) 公開性検証。リダイレクト先を採るので、短縮URL（t.co・youtu.be 等）はここで展開される。
  //    サイト別の表を持たない代わりに、実際のリダイレクトだけが表記ゆれを吸収する
  //    タイトルは「見ている本人のブラウザが持っているもの」を優先する。
  //    サーバーが取りに行くHTMLは当てにならない（YouTube は " - YouTube" しか返さないことがある）
  let title = sanitizeTitle(clientTitle);
  if (verify) {
    let result;
    try { result = await verify(normalized.url); }
    catch (e) { throw rejectAs(e); }
    title ??= result.title; // クライアントが送ってこなかったときだけ、取りに行った分を使う
    if (result.finalUrl && result.finalUrl !== normalized.url) {
      try {
        assertPostable(result.finalUrl);
        normalized = normalizeUrl(result.finalUrl, RULES);
      } catch (e) { throw rejectAs(e); }
    }
  }

  const url_hash = store.urlHash(normalized.url);
  const base_domain = baseDomain(normalized.host);
  if (!base_domain) throw new ApiError(400, "url_not_public_host");

  // 6) グローバル禁止リスト（キーは normalized_key）
  const denied = await store.denyHits({
    tagKeys: [prepared.normalized_key], domains: [base_domain], urlHashes: [url_hash],
  });
  if (denied.length) throw new ApiError(403, "denied", { by: denied[0].sk.split("#")[0].toLowerCase() });

  // 7) 同じURLに1つの端末鍵から付けられる数の上限（大喜利を阻害しない範囲。01 §3）
  //    ★ poster はタグの「作者」ではない。連投とUndoのためだけに持つ濫用対策の鍵で、
  //      誰にも表示せず、通知もせず、クレジットもしない（03 §1 / 08 §8）
  const existing = existingTags ?? await store.tagsOfUrl(url_hash);
  if (existing.some((t) => t.tag_id === prepared.tag_id)) {
    return { ok: true, duplicate: true, url: normalized.url, url_hash, tag_id: prepared.tag_id };
  }
  if (enforceLimits && existing.filter((t) => t.poster === anon).length >= LIMITS.perUrlPerPoster) {
    throw new ApiError(429, "rate_url_poster", { limit: LIMITS.perUrlPerPoster });
  }

  // 8) 作成。impr / status は M2 で使うが最初から持たせる（後付けは移行が要る）
  const item = {
    pk: store.urlPk(url_hash),
    sk: store.tagSk(url_hash, prepared.tag_id),
    type: "TAG",
    url_hash,
    url: normalized.url,
    base_domain,
    norm_v: normalized.norm_v,
    tag_id: prepared.tag_id,
    tag_text: prepared.display_form,
    normalized_key: prepared.normalized_key,
    title,
    status: "active",
    reach: 0,
    impr: 0,
    rb: 0,
    created_at: now,
    poster: anon,
    event_id,
    // GSI2（新着順）にだけ載せる。GSI1（人気順）は S を持ってから＝到達が付いてから（02 §6）
    gsi2pk: store.domainTagPk(base_domain, prepared.tag_id),
  };
  const created = await store.putTag(item);
  if (!created) {
    // ★ここに来るのは「本体は既にあるが、この呼び出しは確かに投稿された」場合:
    //   同時投稿で負けた / 前回が本体を書いた直後に落ちて再送された、のどちらか。
    //   後者で何もせずに返すと、本体だけあって発信者情報ログが無いタグが残る
    //   （実際に起きた。経緯は seed/repair-logs.mjs）。
    //   ログは「多い」分には害が無く、欠けると後から作れない（08 §5-6）ので必ず書く
    await store.putPostLog({
      now, url_hash, url: normalized.url, tag: prepared.display_form,
      tag_id: prepared.tag_id, poster: anon, ip, ua,
    });
    return { ok: true, duplicate: true, url: normalized.url, url_hash, tag_id: prepared.tag_id };
  }
  if (existing.length === 0) await store.incrementUrlCount(now);

  // 9) 投稿ログ（発信者情報）。★ 最初の書き込みと同時に存在しなければならない
  await store.putPostLog({
    now, url_hash, url: normalized.url, tag: prepared.display_form,
    tag_id: prepared.tag_id, poster: anon, ip, ua,
  });

  return { ok: true, duplicate: false, url: normalized.url, url_hash, tag_id: prepared.tag_id, tag_text: item.tag_text };
}

// 取り消せる時間。UIは5秒と見せるが、オフラインで送信が遅れた分も救えるよう少し広く取る
export const UNDO_WINDOW_MS = 60_000;

/**
 * POST /v1/tags/undo — 自分が今付けたタグを取り消す（docs/05 §4.2）
 *   ★取り消せるのは「自分が」「たった今」付けたものだけ。
 *     他人のタグや時間の経ったタグは対象外（それは「削除の申出」第1条の話になる）
 */
export async function undoTag({ url, tag, anon, now = Date.now() }) {
  if (!url || !tag) throw new ApiError(400, "url_and_tag_required");
  let normalized, prepared;
  try {
    normalized = normalizeUrl(url, RULES);
    prepared = prepareTag(tag);
  } catch (e) { throw rejectAs(e); }

  const url_hash = store.urlHash(normalized.url);
  const item = await store.getTag(url_hash, prepared.tag_id);
  if (!item) return { ok: true, removed: false }; // まだ届いていない/既に消えている

  if (item.poster !== anon) throw new ApiError(403, "not_yours");
  if (now - item.created_at > UNDO_WINDOW_MS) throw new ApiError(410, "undo_expired");

  await store.deleteTag(url_hash, prepared.tag_id);
  // そのURLの最後の1件だったら、URL件数も戻す
  const rest = await store.tagsOfUrl(url_hash);
  if (!rest.length) await store.decrementUrlCount(now);
  return { ok: true, removed: true, url: normalized.url, tag_id: prepared.tag_id };
}

/**
 * POST /v1/reach — 到達の記録（docs/02 §3）。検索結果ページから目的ページへ遷移したときに1回。
 *
 *   ★これが表示寿命を延ばす唯一の入力（→ isDisplayable）。使われているタグは見え続け、
 *     使われないタグは表示から沈む
 *   ★キーはサーバー自身が検索結果として返した (url_hash, tag_id) なので、
 *     送り返してもこちらが知る情報は増えない（フルURLを送らせる必要がない）
 *   ★認証しない。代わりに、同じ組み合わせは LIMITS.reachIntervalSec に1回しか数えない
 *     （人気順の入力なので、連打で順位を積ませない。署名トークンは docs/02 §5）
 */
export async function recordReach({ url_hash, tag_id, now = Date.now() }) {
  if (typeof url_hash !== "string" || !/^[0-9a-f]{64}$/.test(url_hash)) throw new ApiError(400, "bad_url_hash");
  if (typeof tag_id !== "string" || !/^[a-z2-7]{16}$/.test(tag_id)) throw new ApiError(400, "bad_tag_id");
  const updated = await store.bumpReach(url_hash, tag_id, now, LIMITS.reachIntervalSec * 1000);
  // 存在しない組み合わせでも 200 を返す（在るか無いかを問い合わせる道具にしない）
  return { ok: true, recorded: Boolean(updated) };
}

/** KPI 日次集計（URLを含まない。05 §1.2） */
export async function recordKpi({ date, domain, shown = 0, with_tags = 0, anon = null, now = Date.now() }) {
  if (!/^\d{8}$/.test(String(date ?? ""))) throw new ApiError(400, "bad_date");
  const base = baseDomain(String(domain ?? ""));
  if (!base) throw new ApiError(400, "bad_domain");
  if (anon) {
    // 投稿の分バケットとは別に数える（KPI のまとめ送りで投稿が止まらないように）
    const { minute } = await store.bumpRateLimit(anon, now, "K#");
    if (minute > LIMITS.kpiPerMinute) throw new ApiError(429, "rate_minute", { retry_after: 60 });
  }
  const n = Math.max(0, Math.min(Number(shown) || 0, 10000));
  const w = Math.max(0, Math.min(Number(with_tags) || 0, n));
  await store.bumpKpi({ date, domain: base, shown: n, with_tags: w, now });
  return { ok: true };
}
