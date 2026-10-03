// Public Suffix List（ICANN セクション同梱版）
//   base_domain の算出と、「PSL に載らないホスト」の判定に使う（docs/05 §5）
//   JSON は import assertion ではなく readFileSync で読む（Node 18 と 22 の両方で同じ書き方が通る）
import { readFileSync } from "node:fs";

const { rules, version } = JSON.parse(readFileSync(new URL("./data/psl.json", import.meta.url), "utf8"));
export const PSL_VERSION = version;

const exact = new Set();
const wildcard = new Set(); // "*.ck" → "ck"
const exception = new Set(); // "!www.ck" → "www.ck"
for (const rule of rules.split("\n")) {
  if (rule.startsWith("!")) exception.add(rule.slice(1));
  else if (rule.startsWith("*.")) wildcard.add(rule.slice(2));
  else exact.add(rule);
}

// ホスト名を正規化する（末尾ドット除去・小文字化）。IDN は URL が既に punycode 化している
export const normalizeHost = (host) => host.toLowerCase().replace(/\.+$/, "");

// 公開接尾辞（"co.jp" 等）を返す。PSL に一致しなければ null
export function publicSuffix(host) {
  const labels = normalizeHost(host).split(".");
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (exception.has(candidate)) return labels.slice(i + 1).join(".");
    if (exact.has(candidate)) return candidate;
    const parent = labels.slice(i + 1).join(".");
    if (parent && wildcard.has(parent)) return candidate;
  }
  return null;
}

// 登録可能ドメイン（"www.example.co.jp" → "example.co.jp"）。取れなければ null
export function baseDomain(host) {
  const h = normalizeHost(host);
  const suffix = publicSuffix(h);
  if (!suffix || suffix === h) return null; // 公開接尾辞そのものは登録可能ドメインではない
  const rest = h.slice(0, -(suffix.length + 1)).split(".");
  return `${rest[rest.length - 1]}.${suffix}`;
}

// PSL に載らないホスト = 社内ドメイン・*.local・生IP・localhost（docs/05 §5 のヒューリスティック）
export const isPublicHost = (host) => baseDomain(host) !== null;
