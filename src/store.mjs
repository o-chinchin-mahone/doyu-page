// DynamoDB アクセス層（シングルテーブル。キー設計は docs/04-architecture.md §3）
//
//   TABLE_NAME があれば DynamoDB（DDB_ENDPOINT があればローカル）、なければメモリ実装。
//   ★ エンティティのロジックは1箇所にしか書かない。バックエンドが差し替えるのは
//     put / update / query / get / batchGet の5つのプリミティブだけ。
//     （メモリ実装では GSI・条件付き書き込み・TTL・ReturnValues を検証できないので、
//       データ層を触ったら必ず npm run test:ddb を通すこと）
import { createHash, randomUUID } from "node:crypto";
import { reachBucket, nextS } from "./rank.mjs";

const TABLE = process.env.TABLE_NAME;
const ENDPOINT = process.env.DDB_ENDPOINT;

// ---- キー組み立て（04 §3 / §4） ---------------------------------------
export const urlHash = (canonicalUrl) => createHash("sha256").update(canonicalUrl).digest("hex");

// 1つのURLのタグは1つのパーティションに集める。鍵は 64文字のハッシュそのもの。
//   ハッシュの前置だけで引ける形にはしない。前置は 256 通りしかなく、256 回で全件を
//   引けてしまう（＝持ち出しが容易）。ハッシュそのものなら総当たりできないので、
//   引くには URL を先に知っている必要がある。
//   shard は持たない。1URLへの書き込みはレート制限（tags.mjs の LIMITS）で頭打ちなので、
//   パーティションが熱くならない
export const urlPk = (hash) => `U#${hash}`;
export const tagSk = (hash, tagId) => `T#${tagId}`;
export const domainTagPk = (domain, tagId) => `D#${domain}#T#${tagId}`;

const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
const ymdhm = (t) => new Date(t).toISOString().slice(0, 16).replace(/[-:T]/g, "");
const ym = (t) => new Date(t).toISOString().slice(0, 7).replace("-", "");
const sec = (ms) => Math.floor(ms / 1000);

// ---- バックエンド: DynamoDB ------------------------------------------
async function dynamoBackend() {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, PutCommand, UpdateCommand, QueryCommand, GetCommand, BatchGetCommand } =
    await import("@aws-sdk/lib-dynamodb");
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient(ENDPOINT
      ? { endpoint: ENDPOINT, region: "ap-northeast-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : {}),
    { marshallOptions: { removeUndefinedValues: true } },
  );

  return {
    async put(item, { ifAbsent = false } = {}) {
      try {
        await doc.send(new PutCommand({
          TableName: TABLE,
          Item: item,
          ...(ifAbsent ? { ConditionExpression: "attribute_not_exists(pk)" } : {}),
        }));
        return true;
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") return false;
        throw e;
      }
    },
    async update(key, { add = {}, set = {}, setIfAbsent = {}, remove = [] } = {}) {
      const names = {}, values = {};
      const sets = [], adds = [], removes = [];
      let i = 0;
      for (const k of remove) { names[`#r${i}`] = k; removes.push(`#r${i}`); i++; }
      for (const [k, v] of Object.entries(set)) {
        names[`#s${i}`] = k; values[`:s${i}`] = v; sets.push(`#s${i} = :s${i}`); i++;
      }
      for (const [k, v] of Object.entries(setIfAbsent)) {
        names[`#s${i}`] = k; values[`:s${i}`] = v; sets.push(`#s${i} = if_not_exists(#s${i}, :s${i})`); i++;
      }
      for (const [k, v] of Object.entries(add)) {
        names[`#a${i}`] = k; values[`:a${i}`] = v; adds.push(`#a${i} :a${i}`); i++;
      }
      const expr = [
        sets.length ? `SET ${sets.join(", ")}` : "",
        adds.length ? `ADD ${adds.join(", ")}` : "",
        removes.length ? `REMOVE ${removes.join(", ")}` : "",
      ].filter(Boolean).join(" ");
      const r = await doc.send(new UpdateCommand({
        TableName: TABLE, Key: key, UpdateExpression: expr,
        ExpressionAttributeNames: names,
        // remove だけの更新では値が1つも無い。空の map を送ると DynamoDB は
        // ValidationException（ExpressionAttributeValues must not be empty）で弾く
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        ReturnValues: "ALL_NEW",
      }));
      return r.Attributes;
    },
    async get(key) {
      return (await doc.send(new GetCommand({ TableName: TABLE, Key: key }))).Item ?? null;
    },
    async del(key) {
      const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
      await doc.send(new DeleteCommand({ TableName: TABLE, Key: key }));
    },
    async batchGet(keys) {
      if (!keys.length) return [];
      const r = await doc.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: keys } } }));
      return r.Responses?.[TABLE] ?? [];
    },
    // ★目視確認のためだけの全走査。アプリの経路では絶対に使わない（RCUを食う）
    async scan(limit = 500) {
      const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
      const r = await doc.send(new ScanCommand({ TableName: TABLE, Limit: limit }));
      return r.Items ?? [];
    },
    async query({ index, pk, skPrefix, limit, cursor, desc = false }) {
      const pkName = index === "gsi1" ? "gsi1pk" : index === "gsi2" ? "gsi2pk" : "pk";
      const skName = index === "gsi1" ? "s" : index === "gsi2" ? "created_at" : "sk";
      const cond = skPrefix ? "#pk = :pk AND begins_with(#sk, :sk)" : "#pk = :pk";
      const r = await doc.send(new QueryCommand({
        TableName: TABLE,
        ...(index ? { IndexName: index } : {}),
        KeyConditionExpression: cond,
        ExpressionAttributeNames: { "#pk": pkName, ...(skPrefix ? { "#sk": skName } : {}) },
        ExpressionAttributeValues: { ":pk": pk, ...(skPrefix ? { ":sk": skPrefix } : {}) },
        ...(limit ? { Limit: limit } : {}),
        ScanIndexForward: !desc,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      return { items: r.Items ?? [], cursor: r.LastEvaluatedKey ?? null };
    },
  };
}

// ---- バックエンド: メモリ（GSI・TTL は近似。単体テスト用） --------------
function memoryBackend() {
  const items = new Map();
  const k = (pk, sk) => `${pk} | ${sk}`;
  const sortKeyOf = (index, item) => (index === "gsi1" ? item.s : index === "gsi2" ? item.created_at : item.sk);
  const pkOf = (index, item) => (index === "gsi1" ? item.gsi1pk : index === "gsi2" ? item.gsi2pk : item.pk);

  return {
    async put(item, { ifAbsent = false } = {}) {
      if (ifAbsent && items.has(k(item.pk, item.sk))) return false;
      items.set(k(item.pk, item.sk), structuredClone(item));
      return true;
    },
    async update(key, { add = {}, set = {}, setIfAbsent = {}, remove = [] } = {}) {
      const cur = items.get(k(key.pk, key.sk)) ?? { ...key };
      for (const [f, v] of Object.entries(setIfAbsent)) if (cur[f] === undefined) cur[f] = v;
      for (const [f, v] of Object.entries(set)) cur[f] = v;
      for (const [f, v] of Object.entries(add)) cur[f] = (cur[f] ?? 0) + v;
      for (const f of remove) delete cur[f];
      items.set(k(key.pk, key.sk), cur);
      return structuredClone(cur);
    },
    async get(key) {
      const hit = items.get(k(key.pk, key.sk));
      return hit ? structuredClone(hit) : null;
    },
    async del(key) { items.delete(k(key.pk, key.sk)); },
    async scan(limit = 500) { return [...items.values()].slice(0, limit).map((i) => structuredClone(i)); },
    async batchGet(keys) {
      // ★ map に structuredClone をそのまま渡さない。map が第2引数に添字を渡し、
      //   Node 22 では structuredClone のオプションとして検証されて落ちる
      //   （Node 18 は黙って無視するので、手元では緑のまま CI だけ赤くなる）
      return keys.map((key) => items.get(k(key.pk, key.sk))).filter(Boolean).map((i) => structuredClone(i));
    },
    async query({ index, pk, skPrefix, limit, cursor, desc = false }) {
      let rows = [...items.values()]
        .filter((i) => pkOf(index, i) === pk && (!skPrefix || String(i.sk).startsWith(skPrefix)))
        .sort((a, b) => (sortKeyOf(index, a) > sortKeyOf(index, b) ? 1 : -1));
      if (desc) rows.reverse();
      if (cursor) {
        const at = rows.findIndex((i) => i.pk === cursor.pk && i.sk === cursor.sk);
        rows = at >= 0 ? rows.slice(at + 1) : rows;
      }
      const page = limit ? rows.slice(0, limit) : rows;
      const more = limit ? rows.length > limit : false;
      const last = page.length && more ? { pk: page.at(-1).pk, sk: page.at(-1).sk } : null;
      return { items: page.map((i) => structuredClone(i)), cursor: last };
    },
  };
}

let backendPromise;
export const backend = () => (backendPromise ??= TABLE ? dynamoBackend() : Promise.resolve(memoryBackend()));
export const _resetForTests = () => { backendPromise = undefined; };

// ---- エンティティ ------------------------------------------------------

/** 検索を含む全経路から消える状態。ここに入れるのは法的削除だけ（08 §2） */
export const HIDDEN_EVERYWHERE = ["removed", "quarantined"];

/**
 * 表示寿命の既定値（docs/03 §2 の陳腐化）。CONFIG アイテムで上書きできる＝デプロイせずに調整できる。
 *   grace … 付いた直後はこの日数だけ必ず表示する
 *   life  … 最後に到達（検索結果→目的ページ）があってからこの日数だけ表示する
 * 判定と考え方は tags.mjs の isDisplayable
 */
export const DEFAULT_DISPLAY_GRACE_DAYS = 14;
export const DEFAULT_DISPLAY_LIFE_DAYS = 180;

export async function config() {
  const db = await backend();
  const row = await db.get({ pk: "CONFIG", sk: "C" });
  return {
    display_grace_days: row?.display_grace_days ?? DEFAULT_DISPLAY_GRACE_DAYS,
    display_life_days: row?.display_life_days ?? DEFAULT_DISPLAY_LIFE_DAYS,
  };
}

export async function urlCount() {
  const db = await backend();
  return (await db.get({ pk: "STAT", sk: "URLS" }))?.n ?? 0;
}

/** タグ作成（UNIQUE (url_id, tag_id)）。既にあれば false */
export async function putTag(item) {
  const db = await backend();
  return db.put(item, { ifAbsent: true });
}

/** そのURLに付いているタグ。1クエリで全部取れる */
export async function tagsOfUrl(hash) {
  const db = await backend();
  const r = await db.query({ pk: urlPk(hash), skPrefix: "T#" });
  return r.items.filter((i) => i.type === "TAG");
}

/** ドメイン内検索・新着順（GSI2） */
export async function searchNewest(domain, tagId, { limit = 20, cursor = null } = {}) {
  const db = await backend();
  const r = await db.query({ index: "gsi2", pk: domainTagPk(domain, tagId), limit, cursor, desc: true });
  // 検索から落とすのは法的削除だけ。muted / collapsed（＝表示から消えたタグ）は出す（03 §2）
  return { items: r.items.filter((i) => !HIDDEN_EVERYWHERE.includes(i.status)), cursor: r.cursor };
}

/** ドメイン内検索・人気順（GSI1。S の降順。未到達タグは索引に載っていない） */
export async function searchPopular(domain, tagId, { limit = 20, cursor = null } = {}) {
  const db = await backend();
  const r = await db.query({ index: "gsi1", pk: domainTagPk(domain, tagId), limit, cursor, desc: true });
  return { items: r.items.filter((i) => !HIDDEN_EVERYWHERE.includes(i.status)), cursor: r.cursor };
}

/** ユーザー（匿名ID）。初回アクセスで作る。trust の判定に created_at を使う */
export async function touchUser(anon, now = Date.now()) {
  const db = await backend();
  return db.update({ pk: `USR#${anon}`, sk: "P" }, {
    setIfAbsent: { created_at: now, type: "USR" },
    set: { last_seen: now },
  });
}

/** レート制限は分バケットだけ（01 §3。日次上限を置かない理由は tags.mjs の LIMITS） */
export async function bumpRateLimit(anon, now = Date.now(), scope = "") {
  const db = await backend();
  const minute = await db.update({ pk: `RL#${scope}${anon}#${ymdhm(now)}`, sk: "C" }, { add: { n: 1 }, set: { ttl: sec(now) + 120 } });
  return { minute: minute.n };
}

/**
 * 投稿バーストの検知（01 §5）。同じ相手が同じドメインへ短時間に大量投稿したら一時凍結する。
 *   who は匿名ID（"A#..."）か、IPの上位ビット（"N#..."）。IPそのものは持たない
 *   凍結と件数はどちらも TTL で消える。恒久的な記録にはしない
 */
export async function frozenUntil(whos, now = Date.now()) {
  const db = await backend();
  const rows = await db.batchGet(whos.map((w) => ({ pk: `FRZ#${w}`, sk: "C" })));
  return Math.max(0, ...rows.map((r) => r.until ?? 0).filter((t) => t > now));
}

export async function bumpBurst(who, domain, { windowMs, now = Date.now() }) {
  const db = await backend();
  const bucket = Math.floor(now / windowMs);
  const row = await db.update({ pk: `BST#${who}#${domain}#${bucket}`, sk: "C" }, {
    add: { n: 1 }, set: { ttl: sec(now + windowMs * 2) },
  });
  return row.n;
}

export async function freeze(who, until) {
  const db = await backend();
  return db.update({ pk: `FRZ#${who}`, sk: "C" }, { set: { until, ttl: sec(until) + 60, type: "FRZ" } });
}

/** 投稿ログ（発信者情報）。★ 後から遡って作れないので最初の書き込みと同時に存在させる */
export async function putPostLog({ now = Date.now(), url_hash, url, tag, tag_id, poster, ip, ua }) {
  const db = await backend();
  const item = {
    pk: `PLOG#${ym(now)}`, sk: `${new Date(now).toISOString()}#${randomUUID()}`,
    type: "PLOG", url_hash, url, tag, tag_id, poster, ip: ip ?? null, ua: ua ?? null,
    ts: now, ttl: sec(now) + 180 * 86400,
  };
  await db.put(item);
  return item;
}

/** グローバル禁止リスト（キーは normalized_key） */
export async function denyHits({ tagKeys = [], domains = [], urlHashes = [] }) {
  const db = await backend();
  const keys = [
    ...tagKeys.map((s) => ({ pk: "DENY", sk: `TAG#${s}` })),
    ...domains.map((d) => ({ pk: "DENY", sk: `DOM#${d}` })),
    ...urlHashes.map((h) => ({ pk: "DENY", sk: `URL#${h}` })),
  ];
  return db.batchGet(keys);
}

export async function addDeny(kind, key, { reason = "", now = Date.now() } = {}) {
  const db = await backend();
  const sk = { tag: `TAG#${key}`, domain: `DOM#${key}`, url: `URL#${key}` }[kind];
  if (!sk) throw new Error(`unknown deny kind: ${kind}`);
  await db.put({ pk: "DENY", sk, type: "DENY", reason, created_at: now });
  const v = await db.update({ pk: "DENY", sk: "VERSION" }, { add: { deny_version: 1 } });
  return v.deny_version;
}

/** 禁止リストから外す（誤って入れた／異議が認められた）。deny_version は必ず上げる */
export async function removeDeny(kind, key) {
  const db = await backend();
  const sk = { tag: `TAG#${key}`, domain: `DOM#${key}`, url: `URL#${key}` }[kind];
  if (!sk) throw new Error(`unknown deny kind: ${kind}`);
  await db.del({ pk: "DENY", sk });
  return (await db.update({ pk: "DENY", sk: "VERSION" }, { add: { deny_version: 1 } })).deny_version;
}

export async function denyVersion() {
  const db = await backend();
  return (await db.get({ pk: "DENY", sk: "VERSION" }))?.deny_version ?? 0;
}

/** URL件数（統計用）。新しいURLに最初のタグが付いた時だけ増やす */
export async function incrementUrlCount(now = Date.now()) {
  const db = await backend();
  return (await db.update({ pk: "STAT", sk: "URLS" }, { add: { n: 1 }, set: { updated_at: now } })).n;
}

/** タグ1件を取り出す（管理者操作用） */
export async function getTag(hash, tagId) {
  const db = await backend();
  return db.get({ pk: urlPk(hash), sk: tagSk(hash, tagId) });
}

/**
 * 状態遷移（docs/03 §2 / 08 §1）。
 *   ★GSI から外す＝検索の全経路から消える。これをするのは removed / quarantined だけ。
 *     muted は「ページ上から見えないが検索では出る」状態なので GSI に残す（03 §2）。
 *     荒らしタグに対して消したいのは表示であって記録ではない
 *   ★物理削除はしない（08 §5-6 の保全。30日は復旧できる状態で残す）
 */
export async function setTagStatus(hash, tagId, status, { now = Date.now() } = {}) {
  const db = await backend();
  const hidden = ["removed", "quarantined"].includes(status);
  const item = await getTag(hash, tagId);
  if (!item) return null;
  return db.update({ pk: urlPk(hash), sk: tagSk(hash, tagId) }, {
    set: {
      status,
      status_at: now,
      // 復旧に必要なので、外す前に GSI のキーを控えておく
      ...(hidden && item.gsi2pk ? { gsi2pk_saved: item.gsi2pk } : {}),
      ...(!hidden && item.gsi2pk_saved ? { gsi2pk: item.gsi2pk_saved } : {}),
      // GSI1（人気順）も同じ扱い。復旧したとき人気順から消えたままにしない
      ...(hidden && item.gsi1pk ? { gsi1pk_saved: item.gsi1pk } : {}),
      ...(!hidden && item.gsi1pk_saved ? { gsi1pk: item.gsi1pk_saved } : {}),
    },
    remove: hidden ? ["gsi1pk", "gsi2pk"] : [],
  });
}

/**
 * 自分が今付けたタグの取り消し（docs/05 §4.2 の Undo）。
 * ★これは唯一の物理削除。運営による削除（08 §2）は論理削除で、こちらとは別物。
 *   誰の目にも触れていない数十秒前の自分の書き込みを無かったことにするだけなので、
 *   保全の対象（申出を受けた記録）には当たらない
 */
export async function deleteTag(hash, tagId) {
  const db = await backend();
  await db.del({ pk: urlPk(hash), sk: tagSk(hash, tagId) });
}

export async function decrementUrlCount(now = Date.now()) {
  const db = await backend();
  return (await db.update({ pk: "STAT", sk: "URLS" }, { add: { n: -1 }, set: { updated_at: now } })).n;
}

/** 削除ログ（申出内容・判断・根拠・日時。08 §5-5） */
export async function putTakedownLog({ now = Date.now(), action, url, url_hash, tag, tag_id, clause, reason, reporter, poster }) {
  const db = await backend();
  const item = {
    pk: `LOG#${ym(now)}`, sk: `${new Date(now).toISOString()}#${randomUUID()}`,
    type: "LOG", action, url, url_hash, tag, tag_id, clause: clause ?? null,
    reason: reason ?? null, reporter: reporter ?? null, poster: poster ?? null, ts: now,
    // ★ 申出を受けた記録は保全する。TTL を付けない
  };
  await db.put(item);
  return item;
}

/**
 * 到達の記録（docs/02 §3。検索結果ページから目的ページへ遷移した回数）。
 *   何のために数えるか・キーの決まりは tags.mjs の recordReach
 *   ページ内チップのクリックは到達ではない（02 §3）。あれは検索を開くだけ
 */
export async function bumpReach(hash, tagId, now = Date.now(), minIntervalMs = 0) {
  const db = await backend();
  const key = { pk: urlPk(hash), sk: tagSk(hash, tagId) };
  // 存在しないキーを update すると空アイテムが生えるので、先に在ることを確かめる
  const item = await db.get(key);
  if (!item) return null;
  // 直前の到達から間が空いていなければ数えない（書き込みもしない）。在否の答えは変えない
  if (now - (item.reach_at ?? 0) < minIntervalMs) return item;

  const reach = (item.reach ?? 0) + 1;
  const set = { reach_at: now };

  // 人気順スコア（02 §6）。rb を跨いだ時だけ書く＝GSI の書き込みは O(log n) に収まる
  const rbNext = reachBucket(reach);
  if (rbNext > (item.rb ?? 0)) {
    const s = nextS(item.s, reach - (item.s_reach ?? 0), now);
    if (s != null) {
      set.s = s;
      set.rb = rbNext;
      set.s_reach = reach;   // 次の ΔR を測る起点
      // ★未到達タグは GSI1 に載せない（02 §6）。ここで初めて人気順の索引に入る。
      //   法的削除で外されている間は載せ直さない（gsi2pk が無い＝隠されている状態）
      if (item.gsi2pk) set.gsi1pk = item.gsi2pk;
    }
  }

  return db.update(key, { add: { reach: 1 }, set });
}

/** KPI 日次集計（URLを含まない。05 §1.2 の被覆率測定の代替） */
export async function bumpKpi({ date, domain, shown = 0, with_tags = 0, now = Date.now() }) {
  const db = await backend();
  return db.update({ pk: `KPI#${date}`, sk: `D#${domain}` }, {
    add: { shown, with_tags },
    set: { ttl: sec(now) + 400 * 86400, type: "KPI" },
  });
}
