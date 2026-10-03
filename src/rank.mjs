// 人気順のスコア（docs/02 §6）。純粋な計算だけを置く
//
//   半減期 H = 60日。減衰到達量 R(t) = Σ_i w_i · 2^{-(t-t_i)/H} を、
//   対数＋時刻オフセット形式で持つ:
//
//     S = log2(R) + t/H = log2( Σ_i w_i · 2^{t_i/H} )   ← t に依存しない
//
//   ★S は書き込み時にしか変わらず、決して減らない。だから GSI のソートキーに使える。
//     「減衰」は読み取り時に時刻を引いて初めて現れる（04 §4）。
//   ★更新は rb = floor(log2(reach+1)) を跨いだ時だけ。毎到達で書くと GSI の
//     delete+insert が毎回走り、書き込みが到達数に比例してしまう。
//   ★w は当面 1 で固定する。docs/02 §3 の重み付け（位置・trust）は、到達経路が
//     無認証で「誰が」を持たないため今は計算できない。署名付き impression token
//     （02 §5）が入って初めて意味を持つ。

export const HALF_LIFE_DAYS = 60;
const DAY_MS = 86_400_000;

/** 到達バケット。ここを跨いだ時だけ S を書き直す */
export const reachBucket = (reach) => Math.floor(Math.log2(Math.max(0, reach) + 1));

/**
 * S を更新する。log-sum-exp で足す（桁溢れと桁落ちを避ける）。
 * @param {number|null|undefined} sOld 既存の S（未到達なら無い）
 * @param {number} deltaR 前回 S を書いてから積んだ到達量（w=1 なら件数）
 */
export function nextS(sOld, deltaR, now = Date.now()) {
  if (!(deltaR > 0)) return sOld ?? null;
  const b = now / (DAY_MS * HALF_LIFE_DAYS) + Math.log2(deltaR);
  if (sOld == null || !Number.isFinite(sOld)) return b;
  const a = sOld;
  return Math.max(a, b) + Math.log2(1 + 2 ** -Math.abs(a - b));
}

/**
 * 表示用に減衰後の到達量へ戻す（並び替えには使わない。S の大小で足りる）。
 *   R = 2^(S - t/H)
 */
export const decayedReach = (s, now = Date.now()) =>
  (s == null ? 0 : 2 ** (s - now / (DAY_MS * HALF_LIFE_DAYS)));
