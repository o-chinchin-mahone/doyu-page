// Cloudflare Worker（docs/09 M5 / 04 §8）— どゆページの前段
//
//   なぜ Worker で中継するのか:
//     素通しの CNAME では Host / SNI が Function URL と合わず 522/502 になる。
//     Host・SNI の上書きは Enterprise 限定なので、Worker の fetch() で中継するしかない。
//
//   この Worker が担うこと:
//     1. Function URL の生ホスト名を隠す（公開リポジトリにも拡張にも出さない）
//     2. 共有シークレットを付ける → Lambda が直撃を 403 で落とせるようになる
//     3. 書き込みのときだけ、本当のクライアントIPを渡す（発信者情報。docs/07 §3.1）
//     4. 読み取りでは Cookie を落とす（docs/04 §7: 完全無認証・無Cookie）
//     5. データセンターからの書き込みを断る（docs/01 §3。読み取りは通す）
//
//   シークレット（wrangler secret put）:
//     ORIGIN        Function URL（例 https://xxxx.lambda-url.ap-northeast-1.on.aws）
//     ORIGIN_SECRET Lambda と共有する合言葉（SSM /doyu/<stage>/origin-secret と同じ値）

// クライアントが勝手に名乗れてはいけないヘッダ。必ず落としてから付け直す
const SPOOFABLE = ["x-doyu-origin", "x-doyu-client-ip", "cf-connecting-ip", "x-forwarded-for"];

// データセンター（クラウド・貸しサーバー）の AS 番号。ここからの書き込みは人の手によるものではないとみなす。
//   ★家庭・携帯の回線を持つ事業者は入れない（正当な利用者を巻き込む）。
//     Cloudflare・Akamai・Fastly も入れない（ブラウザやOSの中継機能の出口になっている）。
//   ★VPN の多くはここに載っている事業者を使うので、VPN 越しの書き込みも断ることになる（2026-10-03 に了承）
export const DATACENTER_ASNS = new Set([
  16509, 14618,          // Amazon
  15169, 396982,         // Google
  8075,                  // Microsoft
  31898,                 // Oracle
  45102, 37963,          // Alibaba
  132203, 45090,         // Tencent
  14061,                 // DigitalOcean
  63949,                 // Linode
  20473,                 // Vultr
  16276,                 // OVH
  24940,                 // Hetzner
  51167,                 // Contabo
  12876,                 // Scaleway
  60781,                 // Leaseweb
  9009,                  // M247
  212238,                // Datacamp
  7684, 9370, 9371,      // さくらインターネット
]);

// 匿名IDの発行だけは通す。断ると、読むだけの人の拡張まで起動時につまずく
const WRITE_EXEMPT = new Set(["/v1/hello"]);

export default {
  async fetch(request, env) {
    if (!env.ORIGIN || !env.ORIGIN_SECRET) {
      return new Response("worker is not configured", { status: 500 });
    }

    // 連打を止める（wrangler.toml の RATE_LIMITER。1IPあたり 60秒で 60 リクエスト）。
    //   ★これは「全件を持っていかれる」のを遅くするためのもので、止めきることはできない。
    //     ゆっくり叩かれれば通る。ダッシュボードのレート制限ルールは独自ドメインにしか
    //     付けられないので、workers.dev で動かす間はここが唯一の防壁になる
    if (env.RATE_LIMITER) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "60", "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    const origin = new URL(env.ORIGIN);
    const url = new URL(request.url);

    if (request.method === "POST" && !WRITE_EXEMPT.has(url.pathname) && DATACENTER_ASNS.has(request.cf?.asn)) {
      return new Response(JSON.stringify({ error: "datacenter_blocked" }), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    url.protocol = "https:";
    url.hostname = origin.hostname;
    url.port = "";

    const headers = new Headers(request.headers);
    for (const h of SPOOFABLE) headers.delete(h);
    headers.set("host", origin.hostname);
    headers.set("x-doyu-origin", env.ORIGIN_SECRET);

    // ★書き込みのときだけ発信者のIPを渡す。読み取りには渡さない（04 §7）
    if (request.method === "POST") {
      const ip = request.headers.get("cf-connecting-ip");
      if (ip) headers.set("x-doyu-client-ip", ip);
    } else {
      headers.delete("cookie");
    }

    const upstream = new Request(url, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    // ★エッジキャッシュは有効にしていない（EDGE_CACHE=off）。
    //   Free プランではキャッシュキーにヘッダを含められない（Enterprise 限定）。
    //   Lambda は Origin を見て CORS のヘッダを付けるので、Origin 無しで取られた応答が
    //   キャッシュに入ると、拡張がそれを受け取って CORS で落ちる。
    //   on にするなら、先に CORS のヘッダをこの Worker で付けるようにすること。
    //   そのときの TTL は 60秒（imp_token の exp_bucket が60秒固定なので整列させる。30秒にしない）
    const cacheable = env.EDGE_CACHE === "on"
      && request.method === "GET"
      && (url.pathname === "/v1/search" || url.pathname === "/v1/tags");

    return fetch(upstream, cacheable ? { cf: { cacheTtl: 60, cacheEverything: true } } : undefined);
  },
};
