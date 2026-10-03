// 運用用ページ。admin.mjs の操作を、手元のブラウザの画面1枚から押せるようにする
//
//   ★手元でだけ開く。インターネットには出さない（Lambda には入らない。deploy.mjs が zip に入れるのは src/ だけ）
//   ★127.0.0.1 にだけ束縛する。そのうえで、ブラウザ経由で外から触られる道を3つ塞ぐ:
//       Host が自分でない          … 403（DNS リバインディング。よそのドメイン名をこの番地に向けて読みに来る）
//       POST の Origin が自分でない … 403（よそのサイトが勝手に送ってくる）
//       POST が JSON でない         … 415（フォーム送信は事前確認なしに届くので、JSON だけ受ける）
//   ★操作の本体は admin-lib.mjs（コマンドと同じもの）。ここに処理を書かない
//   ★申出は保存しない。貼ったメールはブラウザの中で読むだけで、サーバーへも送らない
//
//   使い方（STAGE と AWS 認証情報が要る。ローカル確認は DDB_ENDPOINT も。認証の出し方は admin.mjs と同じ）:
//     STAGE=dev node scripts/admin-page.mjs        # http://127.0.0.1:3001 を開く
//     PORT=3002 STAGE=dev node scripts/admin-page.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { STAGE, names } from "./config.mjs";
import { createAdmin, AdminError, CLAUSES, clauseOf, parseReport } from "./admin-lib.mjs";
import { baseDomain } from "../src/psl.mjs";
import { NormalizeError } from "../src/normalize.mjs";
import { TagError } from "../src/tag.mjs";

const PAGE = readFileSync(new URL("./admin-page.html", import.meta.url), "utf8");
const MAX_BODY = 64 * 1024;
const MAX_REASON = 500;

const HASH = /^[0-9a-f]{64}$/;
const TAG_ID = /^[a-z2-7]{16}$/;

// いまの状態がこの中にあるときだけ操作を通す（画面が古いまま押したときの取り違えを防ぐ）
//   ★消してあるタグを「隠す」に変えると検索に戻ってしまう。戻すのは「戻す」だけにする
const LIVE = ["active", "collapsed", "muted"];
const FROM = {
  remove: LIVE,
  mute: ["active", "collapsed"],
  unmute: ["muted"],
  restore: ["removed", "quarantined"],
};

const text = (v, max = MAX_REASON) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const target = (b) => {
  if (!HASH.test(b.url_hash ?? "") || !TAG_ID.test(b.tag_id ?? "")) throw new AdminError("対象のタグを特定できません");
  return { hash: b.url_hash, tag_id: b.tag_id };
};

// ★号は 1〜12 だけ。画面でも止めているが、ここでも必ず弾く（画面を通らない送信があり得る）
const grounds = (b) => {
  const clause = clauseOf(b.clause);
  if (!clause) throw new AdminError("号を選んでください（1〜12）");
  const reason = text(b.reason);
  if (!reason) throw new AdminError("理由を書いてください（記録に残ります）");
  return { clause, reason, reporter: text(b.reporter, 200) || null };
};

// サイトを止めるときの鍵は、タグを付けるときに照合するのと同じ形（登録できるドメイン）に揃える。
// URL を貼っても、www 付きで書いても通るようにする
const siteOf = (value) => {
  let host = value;
  try { if (value.includes("://")) host = new URL(value).hostname; } catch { /* そのまま渡して下で弾く */ }
  const base = baseDomain(host);
  if (!base) throw new AdminError("サイトを読み取れません（example.com の形か、そのサイトの URL で）");
  return base;
};

async function act(admin, b) {
  switch (b.action) {
    case "remove":
      await admin.remove({ ...target(b), ...grounds(b), from: FROM.remove });
      return { ok: true };
    case "remove-all": {
      if (!HASH.test(b.url_hash ?? "")) throw new AdminError("対象のページを特定できません");
      return { ok: true, ...(await admin.removeAll({ hash: b.url_hash, ...grounds(b) })) };
    }
    case "mute": {
      const reason = text(b.reason);
      if (!reason) throw new AdminError("理由を書いてください（記録に残ります）");
      await admin.mute({ ...target(b), reason, from: FROM.mute });
      return { ok: true };
    }
    case "unmute":
      await admin.unmute({ ...target(b), from: FROM.unmute });
      return { ok: true };
    case "restore":
      await admin.restore({ ...target(b), reason: text(b.reason) || null, from: FROM.restore });
      return { ok: true };
    case "deny": {
      if (!["tag", "domain", "url"].includes(b.kind)) throw new AdminError("種類を選んでください");
      const value = text(b.value, 2000);
      if (!value) throw new AdminError("止める対象を書いてください");
      const reason = text(b.reason);
      // ページは鍵がハッシュになり、一覧で見ても何のページか分からない。理由に URL を添えておく
      const { key } = b.kind === "url"
        ? await admin.deny("url", value, { reason: reason ? `${reason}（${admin.locate(value).url}）` : admin.locate(value).url })
        : await admin.deny(b.kind, b.kind === "domain" ? siteOf(value) : value, { reason });
      return { ok: true, key };
    }
    case "undeny": {
      // 一覧に出ている鍵をそのまま受ける（ページの鍵はハッシュなので、URL からは作り直せない）
      if (!["tag", "domain", "url"].includes(b.kind) || typeof b.key !== "string" || !b.key) {
        throw new AdminError("外す対象を特定できません");
      }
      await admin.undenyKey(b.kind, b.key);
      return { ok: true };
    }
    default:
      throw new AdminError("その操作はありません");
  }
}

/**
 * @param {object} opts.admin createAdmin の戻り値
 * @param {string} opts.stage 画面の上に出すステージ名
 * @param {string} opts.where 触っている表の名前（画面と起動時の表示に出す）
 */
export function createAdminServer({ admin, stage, where = "" }) {
  // 画面に埋めるスクリプトとスタイルだけを通す（外部の CSS / JS / フォントは読み込まない）
  const nonce = randomBytes(16).toString("base64");
  const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  const fill = { STAGE: stage, WHERE: json(where), NONCE: nonce, CLAUSES: json(CLAUSES), PARSE: parseReport.toString() };
  const html = PAGE.replace(/__(STAGE|WHERE|NONCE|CLAUSES|PARSE)__/g, (_, k) => fill[k]);

  const server = createServer(async (req, res) => {
    const send = (status, body, type = "application/json; charset=utf-8") => {
      res.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    try {
      const { port } = server.address();
      // ★Host を見る。127.0.0.1 に束縛していても、よそのドメイン名をこの番地に向ければ
      //   ブラウザは「そのドメインのページ」として読みに来られる（DNS リバインディング）
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
        return send(403, { error: "この番地では開けません" });
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      if (req.method === "GET") {
        if (url.pathname === "/") return send(200, html, "text/html; charset=utf-8");
        if (url.pathname === "/api/overview") {
          const [over, deny] = [await admin.overview(), await admin.denyList()];
          return send(200, { ...over, deny: deny.entries, deny_version: deny.version });
        }
        if (url.pathname === "/api/page") {
          const raw = url.searchParams.get("url");
          if (!raw) throw new AdminError("ページの URL を入れてください");
          return send(200, await admin.pageTags(raw, url.searchParams.get("tag")));
        }
        return send(404, { error: "ありません" });
      }

      if (req.method !== "POST") return send(405, { error: "使えない方法です" });
      // ★書き込みは、この画面自身から来たものだけ受ける。Origin が無いものも通さない
      if (![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) {
        return send(403, { error: "この画面からの操作ではありません" });
      }
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
        return send(415, { error: "JSON だけ受け付けます" });
      }
      if (url.pathname !== "/api/act") return send(404, { error: "ありません" });

      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) return send(413, { error: "大きすぎます" });
        chunks.push(c);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
      if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, { error: "JSON を読めません" });

      return send(200, await act(admin, body));
    } catch (e) {
      if (e instanceof AdminError) return send(400, { error: e.message });
      if (e instanceof NormalizeError) return send(400, { error: `URL を読み取れません（${e.code ?? e.message}）` });
      if (e instanceof TagError) return send(400, { error: `タグを読み取れません（${e.code}）` });
      // AWS の認証切れなどはここに来る。中身は端末に出し、画面には種類だけ返す
      console.error(e);
      return send(500, { error: `失敗しました（${e.name}）。端末の表示を見てください。AWS の認証が切れていないか確かめてください` });
    }
  });
  return server;
}

// 直接起動されたときだけ立てる（テストは createAdminServer をメモリ実装の store で呼ぶ）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // ★ store.mjs は読み込み時に TABLE_NAME を見て、無ければメモリ実装に落ちる。
  //   ステージから表名を決めてから読み込むこと（理由は admin.mjs の冒頭）
  process.env.TABLE_NAME ??= names().table;
  const store = await import("../src/store.mjs");
  const { isDisplayable } = await import("../src/tags.mjs");

  const where = `${process.env.TABLE_NAME}${process.env.DDB_ENDPOINT ? `（${process.env.DDB_ENDPOINT}）` : ""}`;
  const port = Number(process.env.PORT) || 3001;
  // ★ 127.0.0.1 に束縛する。ホスト未指定だと全インターフェイスで待ち受け、同じ LAN の他端末から届いてしまう
  createAdminServer({ admin: createAdmin({ store, isDisplayable }), stage: STAGE, where })
    .listen(port, "127.0.0.1", () => {
      // 「どこを触るのか」を必ず先に出す。取り違えて消すのが一番まずい
      console.error(`[${STAGE}] ${where}`);
      console.log(`http://127.0.0.1:${port}`);
    });
}
