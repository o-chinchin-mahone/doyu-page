const $ = (id) => document.getElementById(id);

async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `http_${res.status}`);
  return body;
}

/**
 * 到達の記録（docs/02 §3）。「検索結果から目的ページへ行った」だけを1回数える。
 *   ★これが無いとタグの表示寿命が延びない（誰も使わないタグはページ上から沈む。03 §2）
 *   ★送るのは検索結果としてサーバーが返してきた url_hash と tag_id だけ。新しい情報は渡さない
 *   ★keepalive を付ける。遷移で中断されても送り切られる
 *   ★失敗しても黙って捨てる。到達が数えられなかったタグは表示寿命が延びないだけ
 */
function reach(url_hash, tag_id) {
  fetch("/v1/reach", {
    method: "POST", keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url_hash, tag_id }),
  }).catch(() => {});
}

let order = "newest";
let current = null; // 直近の検索条件（並び替えボタンで引き直す）

for (const b of document.querySelectorAll("#orders button")) {
  b.addEventListener("click", () => {
    if (order === b.dataset.order) return;
    order = b.dataset.order;
    for (const o of document.querySelectorAll("#orders button")) o.classList.toggle("on", o === b);
    if (current) search(current.domain, current.tag);
  });
}

async function search(domain, tag) {
  current = { domain, tag };
  $("results").hidden = false;
  $("head").textContent = `${domain} の中の「${tag}」`;
  $("list").textContent = "";
  $("err").textContent = "";
  try {
    const r = await api(`/v1/search?${new URLSearchParams({ domain, tag, order })}`);
    if (!r.items.length) {
      // 人気順は「まだ誰も辿っていないタグ」を載せない（docs/02 §6）。空の理由を言い分ける
      $("err").textContent = order === "popular"
        ? "まだ誰も検索結果から辿っていません（新着順には出ます）"
        : "見つかりません";
      return;
    }
    for (const i of r.items) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = i.url;
      a.textContent = i.title || new URL(i.url).pathname; // URLの羅列にしない
      a.rel = "nofollow ugc noopener noreferrer"; // ユーザー投稿リンクに必ず付ける（docs/01 §2.1）
      a.target = "_blank";
      a.addEventListener("click", () => reach(i.url_hash, r.tag_id), { once: true });
      const meta = document.createElement("div");
      meta.className = "muted";
      meta.textContent = new Date(i.created_at).toLocaleDateString("ja-JP");
      li.append(a, meta);
      $("list").append(li);
    }
  } catch (e) {
    $("err").textContent = e.message;
    $("settings").open = true;
  }
}

const params = new URLSearchParams(location.search);
const domain = params.get("domain");

if (domain) {
  // タグは自由に打てる。ドメインは見ていたページから決まる（入力させない）
  $("search").hidden = false;
  $("domain").textContent = `${domain} の中を探す`;
  $("q").value = params.get("tag") ?? "";
  $("q").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return; // 変換確定の Enter は無視
    const tag = $("q").value.trim();
    if (!tag) return;
    // 再読み込みしても同じ結果が出るようにURLも合わせる
    history.replaceState(null, "", `?${new URLSearchParams({ domain, tag })}`);
    search(domain, tag);
  });
  if (params.get("tag")) search(domain, params.get("tag"));
  else $("q").focus();
} else {
  $("intro").hidden = false;
}
api("/v1/params")
  .then((p) => { $("params").textContent = `norm_v=${p.norm_v}`; })
  .catch(() => {});
