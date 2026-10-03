// 公開性検証（docs/05 §4.2）— 採録前に「匿名でGETして200、かつ noindex でない」ことを確かめる
//
//   これで社内URL・署名付き共有リンク・ログイン必須ページが構造的に排除される。
//   同時に、短縮URLの展開（リダイレクト追跡の結果を finalUrl として返す）もここで行う。
//
//   ★SSRF対策は必須:
//     - プライベート／予約IPへの接続を拒否する
//     - DNSリバインディング対策として、解決したIPに固定して接続する（Hostヘッダとsniは正しいまま）
//     - リダイレクトは自前で追跡し、ホップごとに同じ検査をやり直す
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import dns from "node:dns/promises";
import { BlockList, isIPv6 } from "node:net";
import { isPublicHost } from "./psl.mjs";

export class PublicityError extends Error {
  constructor(code) { super(code); this.name = "PublicityError"; this.code = code; }
}

const UA = "doyu-page-verifier/1.0 (+https://github.com/o-chinchin-mahone/doyu-page)";
const MAX_REDIRECTS = 3;
// 上限が小さいとタイトルが取れない。YouTube は <title> が 700KB 付近にある。
//   </head> が見えた時点で打ち切るので、普通のページは数KBで止まる。
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 6000;

// 見たいもの（<title> と meta robots）は全部 <head> の中にある。閉じたら読むのをやめる
export const headClosed = (text) => /<\/head\s*>/i.test(text);

// 到達してはいけないIP（RFC1918 / ループバック / リンクローカル / CGNAT / 文書用 / マルチキャスト等）
const blocked = new BlockList();
for (const [addr, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(addr, bits, "ipv4");
for (const [addr, bits] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ["2001:db8::", 32], ["64:ff9b::", 96],
]) blocked.addSubnet(addr, bits, "ipv6");
// ::ffff:0:0/96（IPv4射影）を ipv6 サブネットとして足してはいけない。
// BlockList は IPv4 の照合時にも射影して比較するため、全IPv4がブロック扱いになる。
// 射影アドレスは v4 に戻してから照合する。

export function isBlockedIp(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  return blocked.check(ip, isIPv6(ip) ? "ipv6" : "ipv4");
}

/**
 * 使うアドレスを1つ選ぶ。★IPv4 を優先する。
 *   VPC 外の Lambda は IPv6 で外に出られない。AAAA を先に返すホスト（YouTube 等）で
 *   先頭をそのまま使うと ENETUNREACH になり、公開性検証が常に失敗する
 */
export const pickAddress = (addrs) => addrs.find((a) => a.family === 4) ?? addrs[0];

/**
 * 解決済みIPに固定する lookup（DNSリバインディング対策）。
 * ★Node 20 以降の `net.connect` は既定で Happy Eyeballs（autoSelectFamily）を使い、
 *   `lookup` を `{ all: true }` で呼んで**配列**を期待する。単一アドレスを返すと
 *   ERR_INVALID_IP_ADDRESS になる（手元の Node 18 では起きず、Lambda の Node 22 で落ちた）
 */
export const pinnedLookup = (pin) => (_host, options, callback) => {
  const cb = typeof options === "function" ? options : callback;
  const wantsAll = typeof options === "object" && options !== null && options.all;
  if (wantsAll) return cb(null, [{ address: pin.address, family: pin.family }]);
  return cb(null, pin.address, pin.family);
};

// ホストを解決し、全アドレスが公開IPであることを確認して1つに固定する
async function pinnedAddress(host) {
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new PublicityError("dns");
  }
  if (!addrs.length) throw new PublicityError("dns");
  // 1つでもプライベートを含むなら拒否（DNSリバインディングは複数レコードでも仕掛けられる）
  if (addrs.some((a) => isBlockedIp(a.address))) throw new PublicityError("private_ip");
  return pickAddress(addrs);
}

// 解決済みIPに固定して1ホップだけ取得する。リダイレクトは追わない
async function fetchOnce(urlStr, { method = "GET" } = {}) {
  const u = new URL(urlStr);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new PublicityError("scheme");
  if (!isPublicHost(u.hostname)) throw new PublicityError("not_public_host");
  const pin = await pinnedAddress(u.hostname);
  const request = u.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = request(u, {
      method,
      headers: { "user-agent": UA, accept: "text/html,*/*;q=0.8", "accept-language": "ja,en;q=0.8" },
      // ★DNSリバインディング対策: 解決済みのIPを使わせる（Host と SNI は u.hostname のまま）
      lookup: pinnedLookup(pin),
      timeout: TIMEOUT_MS,
      // Cookie は送らない・保存しない（匿名でのアクセス可能性を見るため）
    }, (res) => {
      const chunks = [];
      let size = 0;
      let carry = ""; // チャンクの境目で </head> を見落とさないための持ち越し
      res.on("data", (c) => {
        size += c.length;
        chunks.push(c);
        const text = carry + c.toString("utf8");
        if (headClosed(text) || size >= MAX_BYTES) { res.destroy(); return; }
        carry = text.slice(-16);
      });
      res.on("end", () => resolve({
        status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"), url: urlStr,
      }));
      res.on("close", () => resolve({
        status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"), url: urlStr,
      }));
    });
    req.on("timeout", () => { req.destroy(new PublicityError("timeout")); });
    req.on("error", (e) => {
      // URLもIPも残さない。何が起きたかだけ残す（docs/04 §7）
      if (!(e instanceof PublicityError)) console.error("publicity fetch failed", e.code ?? e.name, e.syscall ?? "");
      reject(e instanceof PublicityError ? e : new PublicityError("network"));
    });
    req.end();
  });
}

// robots.txt の Disallow は見ない（docs/09 M1 決定8）。
//   これは巡回ではなく、ユーザーが選んだ1ページを1回だけ取りに行く検証で、索引も作らない。
//   x.com の robots.txt は `User-agent: * / Disallow: /` なので、尊重すると
//   X には永久にタグを付けられなくなる（M3c が成立しない）。
//   「このページを検索に載せるな」という意思表示は noindex の方で受け取る。
const NOINDEX = /<meta[^>]+name\s*=\s*["']?robots["']?[^>]*content\s*=\s*["']?[^"'>]*noindex/i;

/**
 * 匿名で到達でき、noindex でないことを確かめる。短縮URLはここで展開される。
 * @returns {Promise<{finalUrl: string, title: string|null}>}
 * @throws {PublicityError}
 */
export async function verifyPublic(url, { fetchImpl = fetchOnce, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchImpl(current);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    if (res.status !== 200) throw new PublicityError(`status_${res.status}`);

    const xRobots = String(res.headers["x-robots-tag"] ?? "");
    if (/noindex/i.test(xRobots)) throw new PublicityError("noindex");
    if (NOINDEX.test(res.body)) throw new PublicityError("noindex");

    const title = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(res.body)?.[1]
      ?.replace(/\s+/g, " ").trim() ?? null;
    return { finalUrl: current, title: title || null };
  }
  throw new PublicityError("too_many_redirects");
}

export const _fetchOnce = fetchOnce;
