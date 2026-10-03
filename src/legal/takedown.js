// 削除の申出フォーム（/takedown 第2条）。
//   ★どこにも送信しない。必要事項を埋めたメールを作るだけで、送るのは本人のメールソフト。
//     申出の窓口をメール1つに保つため（見る場所を増やさない・連絡先をこちらで持たない）
const form = document.getElementById("report-form");
const result = document.getElementById("report-result");

// 拡張機能のタグから1タップで来たときは、対象を埋めておく
const q = new URLSearchParams(location.search);
if (q.get("u")) form.elements.url.value = q.get("u");
if (q.get("tag")) form.elements.tag.value = q.get("tag");
if (q.get("u") || q.get("tag")) form.scrollIntoView();

// サイト全体の申出では、タグの代わりにURLと権利者であることの説明が必須になる
const syncKind = () => {
  const domain = form.elements.kind.value === "domain";
  form.elements.tag.required = !domain;
  form.elements.url.required = domain;
  form.elements.proof.required = domain;
};
form.elements.kind.addEventListener("change", syncKind);
syncKind();

// 号などの必須項目が埋まっていなければ、ブラウザがここへ来る前に止める
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  const domain = f.kind === "domain";
  const clause = form.elements.clause.selectedOptions[0].textContent;
  const body = [
    domain
      ? "以下のサイトについて、「削除の申出」第1条に基づき、サイト全体へのタグ付けの停止を申し出ます。"
      : "以下のタグについて、「削除の申出」第1条に基づき削除を申し出ます。",
    "",
    `対象URL: ${f.url}`,
    ...(domain ? [] : [`対象タグ: ${f.tag}`]),
    `該当する号: ${clause}`,
    `理由: ${f.reason}`,
    `申出者のお名前: ${f.contact}`,
    `権利者であることの説明: ${f.proof}`,
  ].join("\n");
  const subject = `[削除の申出] ${clause.split(" ")[0]} ${domain ? f.url : f.tag}`;
  location.href = `mailto:abuse@doyu.page?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  result.textContent = "メールソフトに下書きを開きました。内容を確かめて送信してください。開かない場合は、同じ内容を abuse@doyu.page へお送りください。";
});
