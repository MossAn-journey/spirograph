import { useState, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";

// ---- 数学 ----
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a / gcd(a, b)) * b;

// 手書きギア: 描いた輪郭から作った半径テーブル(角度→半径倍率)
// モジュールレベルに置くことで、描画関数から直接参照できる
const CUSTOM_GEAR = { table: null };

// 手書きパスを「中心から見た半径テーブル」に変換
function buildGearTable(pts) {
  const M = 720;
  // 重心を中心にする
  let cx = 0, cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;

  const tbl = new Float64Array(M);
  const filled = new Uint8Array(M);
  let maxR = 1e-6;
  for (const p of pts) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const r = Math.hypot(dx, dy);
    if (r > maxR) maxR = r;
    let a = Math.atan2(dy, dx);
    if (a < 0) a += 2 * Math.PI;
    const idx = Math.round((a / (2 * Math.PI)) * M) % M;
    // 同じ角度に複数点が来たら外側を採用(星型でない形も扱えるように)
    if (!filled[idx] || r > tbl[idx]) {
      tbl[idx] = r;
      filled[idx] = 1;
    }
  }
  // 抜けた角度を線形補間で埋める
  const anyFilled = filled.some((v) => v);
  if (!anyFilled) return null;
  for (let i = 0; i < M; i++) {
    if (filled[i]) continue;
    let lo = i;
    let hi = i;
    let guard = 0;
    while (!filled[((lo % M) + M) % M] && guard++ < M) lo--;
    guard = 0;
    while (!filled[hi % M] && guard++ < M) hi++;
    const a = tbl[((lo % M) + M) % M];
    const b = tbl[hi % M];
    const u = hi === lo ? 0 : (i - lo) / (hi - lo);
    tbl[i] = a + (b - a) * u;
  }
  // 最大半径が1.0になるよう正規化
  for (let i = 0; i < M; i++) tbl[i] = tbl[i] / maxR;
  // 平滑化。移動平均を1回かけただけでは半径が折れ線のままで、
  // 角度に対する変化率が不連続になる → 転がったときに目に見えるギザギザになる。
  // 3回重ねがけするとガウス平滑に近づき、変化率まで滑らかになる。
  let cur = tbl;
  const W = 10;
  for (let pass = 0; pass < 3; pass++) {
    const sm = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      let s = 0;
      for (let k = -W; k <= W; k++) s += cur[((i + k) % M + M) % M];
      sm[i] = s / (2 * W + 1);
    }
    cur = sm;
  }
  return cur;
}

function customGearRadius(theta) {
  const tbl = CUSTOM_GEAR.table;
  if (!tbl) return 1;
  const M = tbl.length;
  const a = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const f = (a / (2 * Math.PI)) * M;
  const i1 = Math.floor(f) % M;
  const u = f - Math.floor(f);
  // 線形補間だと折れ線になり、転がったときに角が出る。
  // 前後の点も使うCatmull-Rom補間なら変化率まで連続になり滑らかにつながる。
  const i0 = (i1 - 1 + M) % M;
  const i2 = (i1 + 1) % M;
  const i3 = (i1 + 2) % M;
  const p0 = tbl[i0];
  const p1 = tbl[i1];
  const p2 = tbl[i2];
  const p3 = tbl[i3];
  const v =
    0.5 *
    (2 * p1 +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
  // 極端に細い部分でも破綻しないよう下限を設ける
  return Math.max(0.15, v);
}

// ハート: 古典的なパラメトリックハート曲線から半径テーブルを作る
// (x=16sin³t, y=13cos t −5cos2t −2cos3t −cos4t)
const HEART_TABLE = (() => {
  const M = 720;
  const tbl = new Float64Array(M);
  const filled = new Uint8Array(M);
  for (let i = 0; i < 4000; i++) {
    const t = (2 * Math.PI * i) / 4000;
    const x = 16 * Math.pow(Math.sin(t), 3);
    // 画面のy軸は下向きなので符号を反転(くぼみが上、尖りが下になる)
    const y = -(
      13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    );
    const r = Math.hypot(x, y) / 17; // 1.0前後に正規化
    let a = Math.atan2(y, x);
    if (a < 0) a += 2 * Math.PI;
    const idx = Math.round((a / (2 * Math.PI)) * M) % M;
    tbl[idx] = r;
    filled[idx] = 1;
  }
  // 抜けた角度を線形補間で埋める
  for (let i = 0; i < M; i++) {
    if (filled[i]) continue;
    let lo = i, hi = i;
    while (!filled[(lo + M) % M]) lo--;
    while (!filled[hi % M]) hi++;
    const a = tbl[((lo % M) + M) % M];
    const b = tbl[hi % M];
    const u = (i - lo) / (hi - lo);
    tbl[i] = a + (b - a) * u;
  }
  return tbl;
})();

function heartRadius(theta) {
  const M = HEART_TABLE.length;
  const a = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const f = (a / (2 * Math.PI)) * M;
  const i0 = Math.floor(f) % M;
  const i1 = (i0 + 1) % M;
  const u = f - Math.floor(f);
  return HEART_TABLE[i0] * (1 - u) + HEART_TABLE[i1] * u;
}

// 曲線の中心からの最大到達距離(自動フィット用)
function maxReach(mode, p, outer) {
  if (mode === "spiro") {
    const base = Math.abs(outer ? p.R + p.r : p.R - p.r);
    if (p.chain) {
      const rr2 = snapChainR2(p.R, p.r, p.r2, outer);
      const off = Math.abs(p.r - rr2);
      return base + off + p.d;
    }
    return base + p.d;
  }
  if (mode === "lissajous") return 250 * Math.SQRT2;
  if (mode === "rose") return p.A;
  return CANVAS_SIZE / 2;
}

// 🍥 風車: 半径がゆっくり増えて急に戻る鋸歯を、1周にk回繰り返す。
// 戻る瞬間が不連続な「切れ目」になり、羽根が並んだ渦巻き状の輪郭になる。
// ペンがその切れ目を通るたびに大きく飛ぶので、模様に鋭い筋が入る。
const PINWHEEL_K = 5; // 切れ目の数(羽根の枚数)
const PINWHEEL_DEPTH = 0.5; // 切れ目の深さ
function pinwheelRadius(theta) {
  const per = (2 * Math.PI) / PINWHEEL_K;
  let u = (((theta % per) + per) % per) / per;
  // 不連続な形状は浮動小数点誤差に弱い。
  // 本来ちょうど区切りに乗るはずの角度が誤差で「あと一息で1周」と判定されると、
  // 半径が最小値ではなく最大値になり、曲線の始点と終点がずれて閉じなくなる。
  // 区切りのごく近傍は0側に丸めて防ぐ。
  if (u > 1 - 1e-9) u = 0;
  return 1 - PINWHEEL_DEPTH + PINWHEEL_DEPTH * u;
}

// ✨ キラリ: スーパー楕円(ラメ曲線) |x|^n + |y|^n = 1 の n < 1 の場合。
// 極形式にすると r = (|cosθ|^n + |sinθ|^n)^(-1/n) と閉じた式で書ける。
// n=2/3 が有名なアステロイド(はしごが壁を滑り落ちる軌跡の包絡線)で、
// n を小さくするほど辺のへこみが深くなり尖りが鋭くなる。
const SPARKLE_N = 0.5;
function sparkleRadius(theta) {
  const c = Math.abs(Math.cos(theta));
  const s = Math.abs(Math.sin(theta));
  return Math.pow(Math.pow(c, SPARKLE_N) + Math.pow(s, SPARKLE_N), -1 / SPARKLE_N);
}

// ルーローの五角形: 正五角形の各頂点を中心とする円弧5本で辺を結んだ定幅曲線。
// どの向きから測っても幅が一定という性質を持つ(英国の20ペンス硬貨は同じ原理の七角形)。
// なお定幅のルーロー多角形は辺の数が奇数のときしか作れない。
// 各円弧は「向かい合う頂点」を中心に描くので、頂点と辺が一対一で対応する必要があるため。
const REULEAUX_N = 5;
const REULEAUX = (() => {
  const verts = [];
  for (let i = 0; i < REULEAUX_N; i++) {
    // 画面のy軸は下向きなので -90° 起点で頂点を1つ上に向ける
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / REULEAUX_N;
    verts.push({ x: Math.cos(a), y: Math.sin(a) });
  }
  const half = (REULEAUX_N - 1) / 2;
  // 中心となる頂点から、円弧の両端になる頂点までの距離
  const R = 2 * Math.sin((half * Math.PI) / REULEAUX_N);
  return { verts, half, R };
})();

function reuleauxRadius(theta) {
  const { verts, half, R } = REULEAUX;
  const n = verts.length;
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const c = verts[i];
    // 原点から角度thetaの半直線と、頂点cを中心とする半径Rの円との交点
    const b = -2 * (c.x * dx + c.y * dy);
    const cc = c.x * c.x + c.y * c.y - R * R;
    const disc = b * b - 4 * cc;
    if (disc < 0) continue;
    const t = (-b + Math.sqrt(disc)) / 2;
    if (t <= 0) continue;
    // その交点が対辺の円弧の範囲に入っているかを角度で判定
    const j = (i + half) % n;
    const k = (i + half + 1) % n;
    const angJ = Math.atan2(verts[j].y - c.y, verts[j].x - c.x);
    const angK = Math.atan2(verts[k].y - c.y, verts[k].x - c.x);
    const angP = Math.atan2(t * dy - c.y, t * dx - c.x);
    const norm = (v) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let d1 = norm(angP - angJ);
    let d2 = norm(angK - angJ);
    if (d2 > Math.PI) {
      d1 = norm(angP - angK);
      d2 = norm(angJ - angK);
    }
    if (d1 <= d2 + 1e-9) best = Math.min(best, t);
  }
  return best === Infinity ? 1 : best;
}

// カッシーニの卵形線: 2定点からの距離の「積」が一定という曲線。
// b/c を 1 に近づけるとレムニスケート(8の字)に漸近する。
// ちょうど b=c だと半径が0になり一部の角度で定義できないため、
// くびれを残しつつ全角度で値を持つ b/c = 1.06 を採用する。
function cassiniRadius(theta) {
  const c = 1;
  const b = 1.06;
  const cos2 = Math.cos(2 * theta);
  const c4 = c * c * c * c;
  const disc = c4 * cos2 * cos2 - c4 + b * b * b * b;
  if (disc < 0) return 0.2;
  const r2 = c * c * cos2 + Math.sqrt(disc);
  const r = r2 > 0 ? Math.sqrt(r2) : 0.2;
  return r / 1.4574; // 最大半径を1に正規化
}

// トラック形状の半径スケール(θごとの倍率)
function shapeScale(shape, theta) {
  // 正多角形(n角形): 辺が直線
  // rot: 見た目を整える回転(三角 △ は頂点を上に、四角 ◻ は辺を水平に)
  const polyCfg = {
    triangle: { n: 3, rot: -Math.PI / 2 },
    square: { n: 4, rot: Math.PI / 4 },
  }[shape];
  if (polyCfg) {
    const { n, rot } = polyCfg;
    const per = (2 * Math.PI) / n;
    const th = theta - rot;
    const m = ((th % per) + per) % per;
    return Math.cos(Math.PI / n) / Math.cos(m - Math.PI / n);
  }

  // 星型(尖った角): 頂点と谷を直線で結ぶ。頂点がひとつ真上に来るよう回転
  const starCfg = {
    star: { points: 5, inner: 0.42 },
  }[shape];
  if (starCfg) {
    const { points, inner } = starCfg;
    const per = (2 * Math.PI) / points;
    const half = per / 2;
    const th = theta + Math.PI / 2; // 画面のy軸は下向きなので +90°で頂点が上へ
    const m = ((th % per) + per) % per;
    const a = m < half ? m : per - m;
    const p1 = { x: 1, y: 0 };
    const p2 = { x: inner * Math.cos(half), y: inner * Math.sin(half) };
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const denom = Math.sin(a) * dx - Math.cos(a) * dy;
    if (Math.abs(denom) < 1e-9) return 1;
    return (p1.y * dx - p1.x * dy) / denom;
  }

  // 花びら型(なめらかな凹凸)
  const petalCfg = { sakura: { n: 5, depth: 0.42 } }[shape];
  if (petalCfg) {
    const { n, depth } = petalCfg;
    return 1 - depth * (0.5 - 0.5 * Math.cos(n * theta));
  }

  if (shape === "heart") {
    return heartRadius(theta);
  }

  if (shape === "custom") {
    return customGearRadius(theta);
  }

  if (shape === "reuleaux") {
    return reuleauxRadius(theta);
  }

  if (shape === "doublecircle") {
    return 1; // 輪郭は円。内側の輪は描画側で相似縮小して重ねる
  }

  if (shape === "sparkle") {
    return sparkleRadius(theta);
  }

  if (shape === "pinwheel") {
    return pinwheelRadius(theta);
  }

  if (shape === "cassini") {
    return cassiniRadius(theta);
  }

  if (shape === "gear") {
    // 歯車: 矩形波状の凹凸(12歯)
    const teeth = 12;
    const w = Math.cos(teeth * theta);
    const sq = Math.tanh(w * 5); // 矩形波を滑らかに近似
    return 1 - 0.12 * (0.5 - 0.5 * sq);
  }

  return 1; // circle / ellipse は別処理
}

const SHAPES = [
  { id: "circle", label: "円" },
  { id: "doublecircle", label: "◎二重丸" },
  { id: "ellipse", label: "楕円" },
  { id: "triangle", label: "三角" },
  { id: "square", label: "四角" },
  { id: "star", label: "星5" },
  { id: "sakura", label: "桜" },
  { id: "heart", label: "ハート" },
  { id: "gear", label: "歯車" },
  { id: "sparkle", label: "✨キラリ" },
  { id: "pinwheel", label: "🍥風車" },
  { id: "reuleaux", label: "定幅5" },
  { id: "cassini", label: "8の字" },
  { id: "custom", label: "✍️手書き" },
];

// プレビュー用: 実際の描画と同じ数式でギアの輪郭をSVGパス化
function shapePath(shape) {
  const N = 240;
  let dstr = "";
  for (let i = 0; i <= N; i++) {
    const t = (2 * Math.PI * i) / N;
    let x, y;
    if (shape === "ellipse") {
      x = Math.cos(t);
      y = 0.62 * Math.sin(t);
    } else {
      const s = shapeScale(shape, t);
      x = s * Math.cos(t);
      y = s * Math.sin(t);
    }
    dstr += (i === 0 ? "M" : "L") + x.toFixed(3) + "," + y.toFixed(3);
  }
  dstr += "Z";
  // ◎二重丸は内側の輪も描き足す
  if (shape === "doublecircle") {
    for (let i = 0; i <= N; i++) {
      const t = (2 * Math.PI * i) / N;
      const x = 0.5 * Math.cos(t);
      const y = 0.5 * Math.sin(t);
      dstr += (i === 0 ? "M" : "L") + x.toFixed(3) + "," + y.toFixed(3);
    }
    dstr += "Z";
  }
  return dstr;
}

// ◎二重丸: 外側の曲線と、それを50%に縮めた相似形を同時に描く。
// R・r・d をすべて同じ比率で縮めた曲線は元の曲線をそのまま縮小したものになるので、
// 各時刻の点を0.5倍するだけで内側の曲線が得られる。
const NEST_RATIO = 0.5;
function nestScales(shape) {
  return shape === "doublecircle" ? [1, NEST_RATIO] : [1];
}

// 形状ごとの「半径の真ん中」をキャッシュする。
// 凹みで逆回転させるとき、どこからを凹みとみなすかの境目に使う。
// 形ごとに半径の振れ幅が違うので、固定値ではなく最小と最大の中間を境目にする。
const SHAPE_MID_CACHE = {};
function shapeMidRadius(shape) {
  if (shape === "custom") {
    // 手書きギアは描き直すたびに形が変わるのでキャッシュしない
    const tbl = CUSTOM_GEAR.table;
    if (!tbl) return 1;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < tbl.length; i++) {
      if (tbl[i] < mn) mn = tbl[i];
      if (tbl[i] > mx) mx = tbl[i];
    }
    return (mn + mx) / 2;
  }
  if (SHAPE_MID_CACHE[shape] !== undefined) return SHAPE_MID_CACHE[shape];
  let mn = Infinity, mx = -Infinity;
  const N = 720;
  for (let i = 0; i < N; i++) {
    const s = shapeScale(shape, (2 * Math.PI * i) / N);
    if (s < mn) mn = s;
    if (s > mx) mx = s;
  }
  const mid = (mn + mx) / 2;
  SHAPE_MID_CACHE[shape] = mid;
  return mid;
}

function curvePoint(mode, t, p, outer) {
  if (mode === "spiro") {
    const { R, r, d, r2, shape, chain, concaveFlip, penReverse } = p;
    const base = outer ? R + r : R - r;
    const k1 = base / r;

    // 基礎トラック(固定ギアの形)
    let bx, by;
    let s = 1;
    if (shape === "ellipse") {
      bx = base * Math.cos(t);
      by = base * 0.62 * Math.sin(t);
    } else {
      s = shapeScale(shape, t);
      bx = base * s * Math.cos(t);
      by = base * s * Math.sin(t);
    }

    let sgn = outer ? -1 : 1;
    // 凹みで逆回転: 半径が平均より内側に入っている間だけペンの回り方を反転させる。
    // 同じ場所を逆向きにもう一度なぞることになり、線が重なって密度が上がる。
    let flip = 1;
    if (concaveFlip && shape !== "ellipse" && s < shapeMidRadius(shape)) {
      flip = -1;
      sgn = -sgn;
    }
    // 逆回転: ペンの回る向きを全域で反転する。
    // 回転の向きだけを変えるので sin 側の符号を入れ替える(cos は偶関数なので変わらない)。
    if (penReverse) flip = -flip;

    if (chain) {
      // 子ギア: 転円rの中でさらにr2が転がり、ペンはr2上
      const rr2 = snapChainR2(R, r, r2, outer);
      const off = r - rr2;
      const k2 = k1 * (off / rr2);
      return {
        x: bx + sgn * off * Math.cos(k1 * t) + sgn * d * Math.cos(k2 * t),
        y: by - flip * off * Math.sin(k1 * t) + flip * d * Math.sin(k2 * t),
      };
    }

    return {
      x: bx + sgn * d * Math.cos(k1 * t),
      y: by - flip * d * Math.sin(k1 * t),
    };
  }
  if (mode === "lissajous") {
    const { a, b, phase } = p;
    const A = 250;
    return {
      x: A * Math.sin(a * t + (phase * Math.PI) / 180),
      y: A * Math.sin(b * t),
    };
  }
  const { n, m, A } = p;
  const rad = A * Math.cos((n / m) * t);
  return { x: rad * Math.cos(t), y: rad * Math.sin(t) };
}

function totalRange(mode, p, outer) {
  if (mode === "fourier") return 2 * Math.PI;
  if (mode === "spiro") {
    const R = Math.round(p.R);
    const r = Math.round(p.r);
    if (p.chain) {
      const rr2 = snapChainR2(R, r, p.r2, outer);
      return 2 * Math.PI * chainPeriod(R, r, rr2, outer);
    }
    return 2 * Math.PI * (r / gcd(R, r));
  }
  if (mode === "lissajous") return 2 * Math.PI;
  const g = gcd(p.n, p.m);
  return 2 * Math.PI * (p.m / g);
}

// 連結ギア: 曲線がちゃんと閉じるように r2 を近傍の「閉じる値」へスナップ
// (実物のスピログラフの歯数が整数なのと同じ理屈)
// 連結ギアが閉じるまでの回転数。
// 転がる向き(内側/外側)で基礎半径が変わり周期も変わるため outer が必須。
function chainPeriod(R, r, r2, outer) {
  const base = Math.abs(outer ? R + r : R - r);
  const q1 = r / gcd(R, r);
  const num2 = Math.abs(base * (r - r2));
  const den2 = r * r2;
  const q2 = den2 / gcd(num2 || 1, den2);
  return lcm(q1, q2);
}

function snapChainR2(R, r, desired, outer) {
  R = Math.round(R);
  r = Math.round(r);
  const lo = 5;
  const hi = Math.max(lo, r - 4);
  const want = Math.max(lo, Math.min(Math.round(desired), hi));
  const LIMIT = 120; // これ以下の回転数で閉じるものを採用
  let best = null;
  let bestT = Infinity;
  for (let c = lo; c <= hi; c++) {
    const T = chainPeriod(R, r, c, outer);
    const dist = Math.abs(c - want);
    if (T <= LIMIT) {
      if (best === null || dist < Math.abs(best - want)) best = c;
    }
    if (T < bestT) bestT = T;
  }
  if (best !== null) return best;
  // どれも閉じないときは最短で閉じるものを選ぶ
  let fallback = want;
  let fT = Infinity;
  for (let c = lo; c <= hi; c++) {
    const T = chainPeriod(R, r, c, outer);
    if (T < fT) {
      fT = T;
      fallback = c;
    }
  }
  return fallback;
}

// 曲線の長さ(回転数)に応じてステップ数を調整
function stepsFor(totalT) {
  const revs = totalT / (2 * Math.PI);
  // 1周あたり最低400点は確保する
  return Math.max(8000, Math.min(200000, Math.round(revs * 500)));
}

// 曲線全体に含まれる「花びら(ローブ)」の総数
// Z波の周波数をこの整数倍/整数分の1にすると、波が花びらの周期とぴったり噛み合う
function loboCount(mode, p, outer, totalT) {
  const revs = totalT / (2 * Math.PI); // 曲線が閉じるまでの基本回転数
  let ratePerRev; // 基本回転1周あたりの花びら数
  if (mode === "fourier") {
    ratePerRev = 1;
  } else if (mode === "spiro") {
    if (p.chain) {
      const rr2 = snapChainR2(p.R, p.r, p.r2, outer);
      const base = outer ? p.R + p.r : p.R - p.r;
      ratePerRev = base / rr2;
    } else {
      ratePerRev = p.R / p.r;
    }
  } else if (mode === "lissajous") {
    ratePerRev = Math.max(p.a, p.b);
  } else {
    ratePerRev = (2 * p.n) / p.m;
  }
  return Math.max(1, Math.round(ratePerRev * revs));
}

// Z波の比率(花びら周期に対する倍率)
const Z_RATIOS = [
  { v: 0.25, label: "¼" },
  { v: 0.5, label: "½" },
  { v: 1, label: "1×" },
  { v: 2, label: "2×" },
  { v: 3, label: "3×" },
];

// 虹ペン: 花びらの発生周期に完全に噛み合う回転数で色相を回す
// (内側・外側とも相対回転 R/r が花びら周期と一致し、閉曲線で色がぴったり揃う)
function rainbowPhase(mode, t, p, outer) {
  const TWO_PI = 2 * Math.PI;
  let rate;
  if (mode === "fourier") {
    rate = 1; // 図形1巡で虹一巡
  } else if (mode === "spiro") {
    if (p.chain) {
      // 子ギアのペン項と、それを運ぶアームの相対回転 = 最小ループの発生周期
      const rr2 = snapChainR2(p.R, p.r, p.r2, outer);
      const base = outer ? p.R + p.r : p.R - p.r;
      rate = base / rr2;
    } else {
      rate = p.R / p.r;
    }
  } else if (mode === "lissajous") {
    rate = Math.max(p.a, p.b);
  } else {
    rate = (2 * p.n) / p.m; // ローズ: 花びら1枚ごと
  }
  const ph = rate * t;
  return (((ph % TWO_PI) + TWO_PI) % TWO_PI) / TWO_PI;
}

const PEN_COLORS = [
  { name: "ルビー", hex: "#ff4d6d" },
  { name: "アンバー", hex: "#ffb347" },
  { name: "ライム", hex: "#9bec5b" },
  { name: "シアン", hex: "#4dd8ff" },
  { name: "バイオレット", hex: "#b388ff" },
  { name: "ホワイト", hex: "#f2f2f2" },
];
const SYMMETRIES = [1, 2, 3, 4, 6];
const CANVAS_SIZE = 640;
const BG = "#0d1021";

// ---- フーリエお絵かき ----
// 手描きパスを弧長で等間隔にリサンプリング
function resamplePath(pts, N) {
  if (pts.length < 2) return pts;
  const seg = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    seg.push(total);
  }
  // 閉じる分も加える
  const closeLen = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  const full = total + closeLen;
  const out = [];
  let j = 0;
  for (let i = 0; i < N; i++) {
    const target = (i / N) * full;
    if (target >= total) {
      // 終点→始点の閉じ区間
      const u = closeLen > 0 ? (target - total) / closeLen : 0;
      const a = pts[pts.length - 1];
      out.push({ x: a.x + (pts[0].x - a.x) * u, y: a.y + (pts[0].y - a.y) * u });
      continue;
    }
    while (j < seg.length - 2 && seg[j + 1] < target) j++;
    const u = (target - seg[j]) / Math.max(seg[j + 1] - seg[j], 1e-9);
    out.push({
      x: pts[j].x + (pts[j + 1].x - pts[j].x) * u,
      y: pts[j].y + (pts[j + 1].y - pts[j].y) * u,
    });
  }
  return out;
}

// 離散フーリエ変換: 複素係数を振幅の大きい順に返す
function fourierCoeffs(pts, M) {
  const N = pts.length;
  const out = [];
  for (let f = -M; f <= M; f++) {
    let re = 0, im = 0;
    for (let k = 0; k < N; k++) {
      const ang = (-2 * Math.PI * f * k) / N;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      re += pts[k].x * ca - pts[k].y * sa;
      im += pts[k].x * sa + pts[k].y * ca;
    }
    re /= N;
    im /= N;
    out.push({ freq: f, amp: Math.hypot(re, im), phase: Math.atan2(im, re) });
  }
  out.sort((a, b) => b.amp - a.amp);
  return out;
}

// 上位n個の円でのペン先位置
function fourierTip(coeffs, n, t) {
  let x = 0, y = 0;
  const m = Math.min(n, coeffs.length);
  for (let i = 0; i < m; i++) {
    const c = coeffs[i];
    x += c.amp * Math.cos(c.freq * t + c.phase);
    y += c.amp * Math.sin(c.freq * t + c.phase);
  }
  return { x, y };
}

const MODES = [
  { id: "spiro", label: "スピロ" },
  { id: "lissajous", label: "リサージュ" },
  { id: "rose", label: "ローズ" },
  { id: "fourier", label: "フーリエ" },
];

// おすすめプリセット
const PRESETS = [
  {
    name: "🌸 クラシック花",
    s: { is3D: false, mode: "spiro", R: 210, r: 63, d: 84, outer: false, shape: "circle", chain: false, sym: 1, penMode: "solid", color: "#ff4d6d" },
  },
  {
    name: "☀️ 太陽コロナ",
    s: { is3D: false, mode: "spiro", R: 160, r: 45, d: 95, outer: true, shape: "circle", chain: false, sym: 1, penMode: "solid", color: "#ffb347" },
  },
  {
    name: "🕸 レース編み",
    s: { is3D: false, mode: "spiro", R: 250, r: 105, d: 115, outer: false, shape: "circle", chain: false, sym: 1, penMode: "solid", color: "#f2f2f2" },
  },
  {
    name: "⭐ 星の万華鏡",
    s: { is3D: false, mode: "spiro", R: 176, r: 30, d: 133, outer: false, shape: "star", chain: true, r2: 40, sym: 2, penMode: "angle", width: 2.5 },
  },
  {
    name: "🌸 桜の万華鏡",
    s: { is3D: false, mode: "spiro", R: 220, r: 70, d: 90, outer: false, shape: "sakura", chain: false, sym: 5, penMode: "angle" },
  },
  {
    name: "⚙️ 三重の渦",
    s: { is3D: false, mode: "spiro", R: 210, r: 63, d: 80, outer: false, shape: "circle", chain: true, r2: 20, sym: 1, penMode: "solid", color: "#b388ff" },
  },
  {
    name: "🎵 リサージュ3:4",
    s: { is3D: false, mode: "lissajous", la: 3, lb: 4, phase: 90, sym: 1, penMode: "solid", color: "#4dd8ff" },
  },
  {
    name: "🌹 五枚花",
    s: { is3D: false, mode: "rose", rn: 5, rm: 1, rA: 260, sym: 1, penMode: "solid", color: "#9bec5b" },
  },
  {
    name: "⚡ ヒートマップ",
    s: { is3D: false, mode: "spiro", R: 240, r: 55, d: 110, outer: false, shape: "circle", chain: false, sym: 1, penMode: "speed" },
  },
  {
    name: "🪐 銀河リング",
    s: { is3D: true, mode: "spiro", R: 220, r: 65, d: 90, outer: false, shape: "circle", chain: false, sym: 3, penMode: "speed", zAmp: 150, zRatio: 1, mirror3d: true },
  },
  {
    name: "🧊 アトミック球",
    s: { is3D: true, mode: "spiro", R: 210, r: 63, d: 84, outer: false, shape: "circle", chain: false, sym: 1, penMode: "speed", zAmp: 60, zRatio: 1, mirror3d: true },
  },
  {
    name: "🌐 ワイヤーグローブ",
    s: { is3D: true, mode: "lissajous", la: 5, lb: 4, phase: 90, sym: 6, penMode: "angle", zAmp: 230, zRatio: 0.5, mirror3d: true },
  },
  {
    name: "🕸 3D万華鏡",
    s: { is3D: true, mode: "spiro", R: 250, r: 105, d: 120, outer: false, shape: "circle", chain: false, sym: 6, penMode: "angle", zAmp: 90, zRatio: 1, mirror3d: true },
  },
  {
    name: "🌪 ねじれタワー",
    s: { is3D: true, mode: "rose", rn: 7, rm: 2, rA: 240, sym: 1, penMode: "speed", zAmp: 250, zRatio: 2, mirror3d: false },
  },
  {
    name: "💎 クリスタル",
    s: { is3D: true, mode: "spiro", R: 200, r: 50, d: 100, outer: false, shape: "star", chain: false, sym: 4, penMode: "solid", color: "#4dd8ff", zAmp: 110, zRatio: 1, mirror3d: true },
  },
  {
    name: "🌌 三重星雲",
    s: { is3D: true, mode: "spiro", R: 268, r: 25, d: 138, outer: false, shape: "circle", chain: true, r2: 52, sym: 1, penMode: "speed", zAmp: 120, zRatio: 1, mirror3d: true },
  },
  {
    name: "🛸 UFOリング",
    s: { is3D: true, mode: "spiro", R: 160, r: 45, d: 95, outer: true, shape: "triangle", chain: false, sym: 3, penMode: "speed", zAmp: 45, zRatio: 2, mirror3d: false },
  },
];

// ============ アイコンモード ============
// 少ない回転数で閉じる「疎な」パラメータのみを扱い、太線・単色・透過で出力する
const ICON_PRESETS = [
  { name: "花3", s: { mode: "spiro", R: 180, r: 60, d: 110, shape: "circle", outer: false } },
  { name: "花4", s: { mode: "spiro", R: 200, r: 50, d: 100, shape: "circle", outer: false } },
  { name: "花5", s: { mode: "spiro", R: 200, r: 40, d: 90, shape: "circle", outer: false } },
  { name: "星5", s: { mode: "spiro", R: 200, r: 80, d: 130, shape: "circle", outer: false } },
  { name: "星7", s: { mode: "spiro", R: 210, r: 90, d: 140, shape: "circle", outer: false } },
  { name: "三つ葉", s: { mode: "spiro", R: 150, r: 50, d: 55, shape: "circle", outer: true } },
  { name: "ローズ3", s: { mode: "rose", n: 3, m: 1, A: 200 } },
  { name: "ローズ5", s: { mode: "rose", n: 5, m: 1, A: 200 } },
  { name: "四つ葉", s: { mode: "rose", n: 2, m: 1, A: 200 } },
  { name: "∞", s: { mode: "lissajous", a: 1, b: 2, phase: 90 } },
  { name: "結び", s: { mode: "lissajous", a: 2, b: 3, phase: 90 } },
  { name: "額縁", s: { mode: "spiro", R: 200, r: 50, d: 55, shape: "square", outer: false } },
  { name: "四つ角", s: { mode: "spiro", R: 200, r: 50, d: 100, shape: "square", outer: false } },
  { name: "三角枠", s: { mode: "spiro", R: 210, r: 70, d: 70, shape: "triangle", outer: false } },
  { name: "三花", s: { mode: "spiro", R: 210, r: 70, d: 120, shape: "triangle", outer: false } },
  { name: "星枠", s: { mode: "spiro", R: 200, r: 40, d: 70, shape: "star", outer: false } },
  { name: "波枠", s: { mode: "spiro", R: 240, r: 30, d: 60, shape: "square", outer: false } },
  { name: "雪片", s: { mode: "spiro", R: 250, r: 25, d: 45, shape: "star", outer: false } },
];

// アイコン用の点列を生成(対称コピー込み・指定サイズにフィット済み)
function iconPolylines(mode, p, outer, sym, size, lineW) {
  const totalT = totalRange(mode, p, outer);
  const revs = totalT / (2 * Math.PI);
  const N = Math.max(600, Math.min(20000, Math.round(revs * 700)));
  const raw = [];
  let maxR = 1e-6;
  for (let i = 0; i <= N; i++) {
    const pt = curvePoint(mode, (totalT * i) / N, p, outer);
    const rr = Math.hypot(pt.x, pt.y);
    if (rr > maxR) maxR = rr;
    raw.push(pt);
  }
  const margin = size * 0.08;
  const scale = (size / 2 - margin - lineW / 2) / maxR;
  const half = size / 2;
  const out = [];
  for (let s = 0; s < sym; s++) {
    const ang = (2 * Math.PI * s) / sym;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    out.push(
      raw.map((pt) => ({
        x: half + (pt.x * ca - pt.y * sa) * scale,
        y: half + (pt.x * sa + pt.y * ca) * scale,
      }))
    );
  }
  return out;
}

// アイコンをキャンバスに描く(背景は透過のまま)
function renderIcon(ctx, mode, p, outer, sym, size, lineW, color) {
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const lines = iconPolylines(mode, p, outer, sym, size, lineW);
  lines.forEach((pts) => {
    ctx.beginPath();
    pts.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
    ctx.stroke();
  });
}

// アイコンをSVG文字列にする(ベクターなので拡大しても劣化しない)
function iconToSVG(mode, p, outer, sym, size, lineW, color) {
  const lines = iconPolylines(mode, p, outer, sym, size, lineW);
  const paths = lines
    .map((pts) => {
      let d = "";
      pts.forEach((q, i) => {
        d += (i === 0 ? "M" : "L") + q.x.toFixed(2) + " " + q.y.toFixed(2);
      });
      return '<path d="' + d + '"/>';
    })
    .join("");
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + " " + size + '" width="' +
    size + '" height="' + size + '">' +
    '<g fill="none" stroke="' + color + '" stroke-width="' + lineW +
    '" stroke-linecap="round" stroke-linejoin="round">' + paths + "</g></svg>"
  );
}

// 背景を消さずにアイコンを重ね描きする(市松模様の上に描く用)
function renderIconKeepBg(ctx, q, size, lineW, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const lines = iconPolylines(q.mode, q.p, q.outer, q.sym, size, lineW);
  lines.forEach((pts) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  });
}

// ランダム生成: R,r を独立に振ると gcd がほぼ1になり100回転級の密な曲線ばかりになる。
// そこで「花びら数 a」と「閉じるまでの回転数 b」(互いに素)を先に決め、R:r を逆算する。
// R = g*a, r = g*b とすると 花びら数 = a, 回転数 = b になる。
function randomSpiroParams(sparse) {
  const petalChoices = sparse ? [3, 4, 5, 6, 7, 8] : [5, 6, 7, 8, 9, 10, 11, 12, 13, 15];
  const revChoices = sparse ? [1, 1, 1, 2] : [1, 2, 2, 3, 3, 4, 5];
  let a = 5;
  let b = 1;
  let g = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    a = petalChoices[Math.floor(Math.random() * petalChoices.length)];
    b = revChoices[Math.floor(Math.random() * revChoices.length)];
    if (gcd(a, b) !== 1) continue;
    // R = a*g を 80〜300、r = b*g を 10〜150 に収める倍率の範囲を求める
    // (あとからクランプすると比が崩れて回転数が跳ね上がるため、先に範囲を決める)
    const gMin = Math.max(Math.ceil(80 / a), Math.ceil(10 / b), 2);
    const gMax = Math.min(Math.floor(300 / a), Math.floor(150 / b));
    if (gMin > gMax) continue; // この比では収まらないので引き直す
    g = gMin + Math.floor(Math.random() * (gMax - gMin + 1));
    break;
  }
  if (!g) {
    a = 5;
    b = 1;
    g = 40;
  }
  const R = a * g;
  const r = b * g;
  // ペン位置は転円半径を基準に。疎なアイコン向けは大きめでループを目立たせる
  const d = Math.round(
    sparse ? r * (1.0 + Math.random() * 1.2) : r * (0.5 + Math.random() * 1.1)
  );
  return { R, r, d: Math.max(10, Math.min(160, d)) };
}

// 互いに素な小さい整数比(リサージュ用)
function randomCoprimePair(maxN) {
  let a, b, guard = 0;
  do {
    a = 1 + Math.floor(Math.random() * maxN);
    b = 1 + Math.floor(Math.random() * maxN);
  } while ((a === b || gcd(a, b) !== 1) && guard++ < 60);
  return [a, b];
}

// 虹ペンの配色バリエーション
// hue を動かすだけだと変化が弱い配色があるため、彩度と明度も範囲で指定して一緒に動かす。
// wrap:true は色相を一周する(繋ぎ目なし)。
// wrap:false は色相を三角波で往復させ、始点と終点の色を揃えて継ぎ目を消す。
// 彩度・明度は継ぎ目を作らないよう常に三角波で往復させる。
//
// speedStops は速度ペン用の別定義(遅い→速いのアンカー)。
// 虹ペンは「始点と終点が同じ色」なのが正解だが、速度ペンは逆に
// 「両端が最大限に違う」のが正解で要件が真逆なため、共用せず配色ごとに持たせる。
// どの配色でも明度を単調に上げる(遅い=暗く沈む → 速い=光る)ことで、
// 色相だけに頼らず、モノクロ印刷や色覚特性の差があっても速度差が読めるようにする。
const RAINBOW_STYLES = [
  {
    id: "vivid",
    label: "ビビッド",
    from: 0,
    to: 360,
    sat: [95, 95],
    light: [55, 68],
    wrap: true,
    // 定番のヒートマップ: 濃紫 → 青 → シアン → 緑 → 黄 → 橙 → 赤。
    // 虹ペンで色相を一周する配色なので、速度ペンでも「一番多くの色を使う」役割を担わせる。
    // このアプリ元来の「青=遅い→赤=速い」の規約に合わせ、最速を鮮やかな赤で締める。
    // 赤は本来の明度が50前後なので、他の配色と違い末端だけ明度が下がる
    // (0→0.82 で 20→66 まで上げ、そこから赤へ向けて 66→54)。
    // 遅い側が十分暗いので速度は読めるうえ、赤はこのランプの他のどこにも出ないため
    // 「最速=赤」は迷わず判別できる
    speedStops: [
      { u: 0.0, h: 270, s: 90, l: 20 },
      { u: 0.16, h: 235, s: 95, l: 32 },
      { u: 0.34, h: 195, s: 95, l: 44 },
      { u: 0.52, h: 145, s: 85, l: 54 },
      { u: 0.68, h: 80, s: 90, l: 62 },
      { u: 0.82, h: 45, s: 100, l: 66 },
      { u: 0.92, h: 22, s: 100, l: 60 },
      { u: 1.0, h: 2, s: 100, l: 54 },
    ],
  },
  {
    id: "gold",
    label: "ゴールド",
    wrap: true,
    // 色相は金色(40-48)に固定し、明度と彩度の揺らぎで金属の光沢を表現する
    stops: [
      { u: 0.0, h: 42, s: 90, l: 38 }, // 深い金(陰)
      { u: 0.2, h: 45, s: 95, l: 58 }, // 明るい金
      { u: 0.38, h: 48, s: 100, l: 78 }, // ハイライト(輝き)
      { u: 0.52, h: 44, s: 92, l: 55 }, // 金
      { u: 0.68, h: 40, s: 80, l: 34 }, // 濃い陰
      { u: 0.84, h: 46, s: 96, l: 66 }, // 反射
      { u: 1.0, h: 42, s: 90, l: 38 }, // → 陰へ戻る
    ],
    // 陰の金 → 輝きの金(元から単調だったので値はそのまま)
    speedStops: [
      { u: 0.0, h: 42, s: 85, l: 32 },
      { u: 1.0, h: 48, s: 100, l: 80 },
    ],
  },
  {
    id: "sunset",
    label: "サンセット",
    from: 320,
    to: 60,
    sat: [88, 100],
    light: [42, 70],
    wrap: false,
    // トワイライト: 夜明け前の藍 → 赤紫 → 朱 → 橙 → 陽光
    speedStops: [
      { u: 0.0, h: 250, s: 70, l: 28 },
      { u: 0.3, h: 318, s: 78, l: 45 },
      { u: 0.6, h: 0, s: 90, l: 56 },
      { u: 0.85, h: 28, s: 100, l: 66 },
      { u: 1.0, h: 48, s: 100, l: 80 },
    ],
  },
  {
    id: "ocean",
    label: "オーシャン",
    from: 150,
    to: 250,
    sat: [88, 88],
    light: [58, 58],
    wrap: false,
    // 深海 → 水面: 沈んだ紺 → 青 → シアン → 陽の当たる水面
    speedStops: [
      { u: 0.0, h: 225, s: 85, l: 22 },
      { u: 0.35, h: 205, s: 90, l: 40 },
      { u: 0.7, h: 185, s: 88, l: 58 },
      { u: 1.0, h: 168, s: 80, l: 86 },
    ],
  },
  {
    id: "forest",
    label: "フォレスト",
    from: 50,
    to: 168,
    sat: [75, 62],
    light: [66, 28],
    wrap: false,
    // 木漏れ日: 森の底の深緑 → ライム → 陽の差す黄。虹ペンとは向きが逆(速い=明るい)
    speedStops: [
      { u: 0.0, h: 158, s: 60, l: 20 },
      { u: 0.35, h: 140, s: 58, l: 35 },
      { u: 0.7, h: 95, s: 65, l: 55 },
      { u: 1.0, h: 62, s: 85, l: 80 },
    ],
  },
  {
    id: "candy",
    label: "キャンディ",
    wrap: true,
    // ゆめかわ/ユニコーンカラーの王道: ピンクとラベンダーを主役に、空色をアクセントに。
    // 真っ青や緑のゾーンを通らないようアンカーで経路を制御する
    stops: [
      { u: 0.0, h: 328, s: 100, l: 78 }, // ゆめみるピンク
      { u: 0.12, h: 318, s: 96, l: 79 }, // ピンクのまま少し滞在
      { u: 0.34, h: 282, s: 88, l: 80 }, // ときめきラベンダー
      { u: 0.5, h: 203, s: 95, l: 78 }, // ユニコーンの空色
      { u: 0.6, h: 185, s: 85, l: 80 }, // アクア
      { u: 0.72, h: 258, s: 82, l: 79 }, // 帰り道のパープル
      { u: 0.9, h: 310, s: 94, l: 78 }, // ピンクに近づく
      { u: 1.0, h: 328, s: 100, l: 78 }, // → ピンクへ戻る
    ],
    // ゆめかわヒート: 夜のパープル → ピンク → コーラル → クリーム
    speedStops: [
      { u: 0.0, h: 268, s: 70, l: 40 },
      { u: 0.3, h: 305, s: 80, l: 58 },
      { u: 0.6, h: 330, s: 95, l: 72 },
      { u: 0.85, h: 15, s: 100, l: 80 },
      { u: 1.0, h: 45, s: 100, l: 90 },
    ],
  },
  {
    id: "pastel",
    label: "パステル",
    wrap: true,
    // 定番パステル色(ベビーピンク→ピーチ→バター黄→ミント→パウダーブルー→ラベンダー)を
    // アンカーとして補間する。色ごとに最適な彩度・明度が違うため一様なスイープでは再現できない
    stops: [
      { u: 0.0, h: 350, s: 100, l: 84 }, // ベビーピンク
      { u: 0.17, h: 25, s: 100, l: 81 }, // ピーチ
      { u: 0.33, h: 52, s: 95, l: 78 }, // バター黄
      { u: 0.5, h: 140, s: 62, l: 76 }, // ミント
      { u: 0.67, h: 216, s: 92, l: 79 }, // パウダーブルー
      { u: 0.84, h: 268, s: 72, l: 81 }, // ラベンダー
      { u: 1.0, h: 350, s: 100, l: 84 }, // → ピンクへ戻る(繋ぎ目なし)
    ],
    // やわらかランプ: くすみラベンダー → パウダーブルー → ミント → バタークリーム。
    // 淡さを保ちたい配色なので、遅い側は他より明るめ(l:55)で止めている
    speedStops: [
      { u: 0.0, h: 250, s: 45, l: 55 },
      { u: 0.33, h: 205, s: 55, l: 68 },
      { u: 0.66, h: 150, s: 55, l: 78 },
      { u: 1.0, h: 48, s: 90, l: 92 },
    ],
  },
];

// アンカー配列を線形補間(色相は近い方向に回る)
function interpStops(stops, u) {
  const t = Math.max(0, Math.min(1, u));
  let i = 0;
  while (i < stops.length - 2 && stops[i + 1].u < t) i++;
  const a = stops[i];
  const b = stops[i + 1];
  const f = (t - a.u) / Math.max(b.u - a.u, 1e-9);
  let dh = b.h - a.h;
  if (Math.abs(dh) > 180) dh -= Math.sign(dh) * 360;
  const h = ((a.h + dh * f) % 360 + 360) % 360;
  return { h, s: a.s + (b.s - a.s) * f, l: a.l + (b.l - a.l) * f };
}

// 0..1 の進行度から色を決める
function rainbowColorAt(styleId, u) {
  const st = RAINBOW_STYLES.find((s) => s.id === styleId) || RAINBOW_STYLES[0];
  if (st.stops) return interpStops(st.stops, ((u % 1) + 1) % 1);
  // 三角波: 0 → 1 → 0。始点と終点が同じ値になるので継ぎ目が出ない
  const tri = 1 - Math.abs(2 * u - 1);
  let hue;
  if (st.wrap) {
    hue = st.from + (st.to - st.from) * u;
  } else {
    let span = st.to - st.from;
    if (Math.abs(span) > 180) span -= Math.sign(span) * 360; // 近い方向に回る
    hue = st.from + span * tri;
  }
  hue = ((hue % 360) + 360) % 360;
  const s = st.sat[0] + (st.sat[1] - st.sat[0]) * tri;
  const l = st.light[0] + (st.light[1] - st.light[0]) * tri;
  return { h: hue, s, l };
}

function rainbowCSS(styleId, u) {
  const c = rainbowColorAt(styleId, u);
  return (
    "hsl(" + Math.round(c.h) + ", " + Math.round(c.s) + "%, " + Math.round(c.l) + "%)"
  );
}

// 速度ペン用: 0(遅い)→1(速い)で単調に変化するグラデーション。
// 配色ごとの speedStops をそのまま辿る(定義と設計意図は RAINBOW_STYLES 側のコメント参照)。
function rampColorAt(styleId, u) {
  const st = RAINBOW_STYLES.find((s) => s.id === styleId) || RAINBOW_STYLES[0];
  const t = Math.max(0, Math.min(1, u));
  if (st.speedStops) return interpStops(st.speedStops, t);
  // speedStops を持たない配色向けのフォールバック。
  // 虹用の定義は一周して戻ってくる前提なので、そのままでは遅い所と速い所が同色になる。
  // 色相を一周する配色は青→赤の定番ヒートマップに、
  // アンカー配列は先頭へ戻る手前までを単調に辿ることで一応の単調性を確保する。
  if (st.stops) {
    const lastU = st.stops[st.stops.length - 2].u;
    return interpStops(st.stops, t * lastU);
  }
  let from, span;
  if (st.wrap) {
    // 定番のヒートマップ: 青(240) → シアン → 緑 → 黄 → 赤(0) と降順に辿る
    from = 240;
    span = -240;
  } else {
    from = st.from;
    span = st.to - st.from;
    if (Math.abs(span) > 180) span -= Math.sign(span) * 360;
  }
  const hue = ((from + span * t) % 360 + 360) % 360;
  const s = st.sat[0] + (st.sat[1] - st.sat[0]) * t;
  const l = st.light[0] + (st.light[1] - st.light[0]) * t;
  return { h: hue, s, l };
}

// 速度 → 0..1 の正規化。
// スピロ曲線の速度は0まで落ちないことが多く、0を基準に割るとランプの下側が丸ごと使われない
// (既定プリセットは最も遅い所でも最速の約1/3の速さがあり、下1/3の色が出番なしになる)。
// 実測の最小〜最大へ引き伸ばして配色の幅を使い切る。
// ただし速度がほぼ一定の曲線(真円など)で微小な差を虹に引き伸ばすと
// 意味のないノイズになるため、変化幅が小さいときは 0 基準のまま(≒ほぼ単色)にする。
function speedFloor(vMin, vMax) {
  return vMax - vMin < vMax * 0.08 ? 0 : vMin;
}

function normSpeed(v, vFloor, vMax) {
  const span = vMax - vFloor;
  if (span <= 1e-6) return 1;
  return Math.max(0, Math.min(1, (v - vFloor) / span));
}

function rampCSS(styleId, u) {
  const c = rampColorAt(styleId, u);
  return (
    "hsl(" + Math.round(c.h) + ", " + Math.round(c.s) + "%, " + Math.round(c.l) + "%)"
  );
}

export default function Spirograph() {
  const canvasRef = useRef(null);
  const mountRef = useRef(null);
  const threeRef = useRef(null);
  const animRef = useRef(null);
  const stateRef = useRef({ t: 0, prev: [], running: false });
  const recRef = useRef(null);
  const pointersRef = useRef(new Map());
  const pinchRef = useRef(0);

  const [is3D, setIs3D] = useState(false);
  const is3DRef = useRef(false);
  useEffect(() => {
    is3DRef.current = is3D;
  }, [is3D]);
  const [mode, setMode] = useState("spiro");
  const modeRef = useRef("spiro");
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const [R, setR] = useState(220);
  const [r, setr] = useState(65);
  const [d, setd] = useState(90);
  const [outer, setOuter] = useState(false);
  const [shape, setShape] = useState("circle");
  const [chain, setChain] = useState(false);
  const [concaveFlip, setConcaveFlip] = useState(false);
  const [penReverse, setPenReverse] = useState(false);
  const [r2, setR2] = useState(28);
  const [la, setLa] = useState(3);
  const [lb, setLb] = useState(4);
  const [phase, setPhase] = useState(90);
  const [rn, setRn] = useState(5);
  const [rm, setRm] = useState(2);
  const [rA, setRA] = useState(260);
  const [zAmp, setZAmp] = useState(80);
  const [zRatio, setZRatio] = useState(1);
  const [mirror3d, setMirror3d] = useState(false);
  const [color, setColor] = useState(PEN_COLORS[3].hex);
  const [penMode, setPenMode] = useState("angle"); // angle(虹・既定) | speed(速度) | solid
  const [rainbowStyle, setRainbowStyle] = useState("vivid");
  const [showSolidPicker, setShowSolidPicker] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  // ランダム時に固定する項目。ONのものは今の設定を保ち、振り直さない
  const [showRandOpts, setShowRandOpts] = useState(false);
  const [lockOpts, setLockOpts] = useState({
    shape: false,
    size: false,
    dir: false,
    sym: false,
    color: true,
    zwave: false,
  });
  const toggleLock = (k) => setLockOpts((o) => ({ ...o, [k]: !o[k] }));
  // 横画面レイアウト。Tailwindのlandscape修飾子に頼らずJSで判定する
  // (十分な幅がないと2カラムは窮屈なので幅の下限も見る)
  const [isLandscape, setIsLandscape] = useState(false);
  useEffect(() => {
    // matchMedia が使えない環境もあるので画面サイズ直読みにフォールバックする
    const check = () =>
      typeof window.matchMedia === "function"
        ? window.matchMedia("(orientation: landscape) and (min-width: 640px)").matches
        : window.innerWidth > window.innerHeight && window.innerWidth >= 640;
    const apply = () => setIsLandscape(check());
    apply();
    let mq = null;
    if (typeof window.matchMedia === "function") {
      mq = window.matchMedia("(orientation: landscape) and (min-width: 640px)");
      if (mq.addEventListener) mq.addEventListener("change", apply);
      else if (mq.addListener) mq.addListener(apply);
    }
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      if (mq) {
        if (mq.removeEventListener) mq.removeEventListener("change", apply);
        else if (mq.removeListener) mq.removeListener(apply);
      }
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
    };
  }, []);
  // 重ね描き(OFFなら描くたびにキャンバスを消して最初から描き直す)
  const [overlay, setOverlay] = useState(false);
  const overlayRef = useRef(false);
  useEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);
  // フーリエお絵かき
  const fourierRef = useRef({ raw: [], coeffs: null, trace: [] });
  const [numCircles, setNumCircles] = useState(40);
  const [hasShape, setHasShape] = useState(false);
  const [sketchMode, setSketchMode] = useState(null); // null | "fourier" | "gear"
  // アイコンモード(疎パラメータ・太線・単色・透過)
  const [iconMode, setIconMode] = useState(false);
  const [iconWidth, setIconWidth] = useState(14);
  const [iconColor, setIconColor] = useState("#f2f2f2");
  const iconPreviewRefs = useRef([]);
  const sketchModeRef = useRef(null);
  const [hasGear, setHasGear] = useState(false);
  const [open, setOpen] = useState({ params: true });
  const toggle = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const [width, setWidth] = useState(1.6);
  const [speed, setSpeed] = useState(4);
  // 2Dキャンバスの表示変換(ピンチズーム・ドラッグパン用。描画データ自体は変えない)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const viewGestureRef = useRef(null);
  const [sym, setSym] = useState(1);
  const [drawing, setDrawing] = useState(false);
  const [recording, setRecording] = useState(false);

  const params = useRef({});
  useEffect(() => {
    params.current = {
      mode, outer, color, penMode, rainbowStyle, width, speed, sym, zAmp, zRatio, mirror3d, numCircles,
      p:
        mode === "spiro"
          ? { R, r, d, r2, shape, chain, concaveFlip, penReverse }
          : mode === "lissajous"
          ? { a: la, b: lb, phase }
          : { n: rn, m: rm, A: rA },
    };
  }, [mode, R, r, d, outer, shape, chain, concaveFlip, penReverse, r2, la, lb, phase, rn, rm, rA, zAmp, zRatio, mirror3d, color, penMode, rainbowStyle, width, speed, sym, numCircles]);

  const getCtx = () => canvasRef.current?.getContext("2d") ?? null;

  const stopDraw = useCallback(() => {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current = null;
    stateRef.current.running = false;
    // 世代を進める。取りこぼした古いループは次のフレームで自滅する
    stateRef.current.gen = (stateRef.current.gen || 0) + 1;
    if (threeRef.current) {
      threeRef.current.draws.forEach((dr) => (dr.done = true));
    }
    setDrawing(false);
    if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    setRecording(false);
  }, []);

  const clearCanvas = useCallback(() => {
    stopDraw();
    setShowRandOpts(false);
    // 手書き形状(フーリエ係数)は資産なので保持し、描画された軌跡だけを消す
    fourierRef.current.trace = [];
    if (threeRef.current) {
      const { group, draws } = threeRef.current;
      draws.forEach((dr) =>
        dr.lines.forEach((ln) => {
          group.remove(ln);
          ln.geometry.dispose();
          ln.material.dispose();
        })
      );
      threeRef.current.draws = [];
    }
    const ctx = getCtx();
    if (ctx) {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    }
  }, [stopDraw]);

  useEffect(() => {
    if (!is3D) clearCanvas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3D]);

  // ---- Three.js セットアップ ----
  useEffect(() => {
    if (!is3D || !mountRef.current) return;
    const container = mountRef.current;
    const size = container.clientWidth;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    const camera = new THREE.PerspectiveCamera(50, 1, 1, 6000);
    camera.position.z = 950;
    const group = new THREE.Group();
    group.rotation.x = -0.55;
    scene.add(group);

    const three = { renderer, scene, camera, group, draws: [], spin: true };
    threeRef.current = three;

    let raf;
    const loop = () => {
      const q = params.current;
      const advance = 12 * q.speed;
      let anyActive = false;
      three.draws.forEach((dr) => {
        if (dr.done) return;
        dr.progress = Math.min(dr.progress + advance, dr.count);
        dr.lines.forEach((ln) => ln.geometry.setDrawRange(0, dr.progress));
        if (dr.progress >= dr.count) {
          dr.done = true;
        } else {
          anyActive = true;
        }
      });
      if (!anyActive && stateRef.current.running3D) {
        stateRef.current.running3D = false;
        setDrawing(false);
        if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
        setRecording(false);
      }
      if (three.spin && pointersRef.current.size === 0) group.rotation.z += 0.0025;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      three.draws.forEach((dr) =>
        dr.lines.forEach((ln) => {
          ln.geometry.dispose();
          ln.material.dispose();
        })
      );
      renderer.dispose();
      container.removeChild(renderer.domElement);
      threeRef.current = null;
    };
  }, [is3D]);

  // ---- タッチ回転・ピンチズーム ----
  const onPointerDown = (e) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const [p1, p2] = [...pointersRef.current.values()];
      pinchRef.current = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    }
  };
  const onPointerMove = (e) => {
    const three = threeRef.current;
    if (!three || !pointersRef.current.has(e.pointerId)) return;
    const prev = pointersRef.current.get(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 1) {
      three.group.rotation.y += (e.clientX - prev.x) * 0.006;
      three.group.rotation.x += (e.clientY - prev.y) * 0.006;
    } else if (pointersRef.current.size === 2) {
      const [p1, p2] = [...pointersRef.current.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (pinchRef.current > 0) {
        three.camera.position.z = Math.max(
          250,
          Math.min(2500, three.camera.position.z * (pinchRef.current / dist))
        );
      }
      pinchRef.current = dist;
    }
  };
  const onPointerUp = (e) => {
    pointersRef.current.delete(e.pointerId);
    pinchRef.current = 0;
  };

  // ---- 録画 ----
  const startRecording = (canvasEl) => {
    if (!canvasEl || !("MediaRecorder" in window)) return;
    try {
      const stream = canvasEl.captureStream(30);
      const mime = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "video/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks = [];
      rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: mime });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = mime.includes("mp4") ? "spirograph.mp4" : "spirograph.webm";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch (err) {
      console.error("録画を開始できませんでした:", err);
    }
  };

  // ---- 3D描画開始 ----
  const startDraw3D = (withRecord) => {
    const three = threeRef.current;
    if (!three) return;
    const q = params.current;
    if (q.mode === "fourier" && !fourierRef.current.coeffs) return;
    const totalT = totalRange(q.mode, q.p, q.outer);
    const N = stepsFor(totalT);
    const dt = totalT / N;
    const baseColor = new THREE.Color(q.color);
    // Z波の山の数を花びら数に同期させる(必ず整数回で閉じ、花びらと噛み合う)
    const lobes = loboCount(q.mode, q.p, q.outer, totalT);
    const zCycles = Math.max(1, Math.round(lobes * q.zRatio));

    // 終点(t=totalT)も含めて曲線を閉じる。
    // 風車のような不連続な形は最後の切れ目で半径が飛ぶため、
    // 終点を描かないと1本ぶんの隙間が残ってしまう。
    const NP = N + 1;

    const lines = [];
    const nests = nestScales(q.p && q.p.shape);
    for (let nIdx = 0; nIdx < nests.length; nIdx++) {
    const nestS = nests[nIdx];
    for (let s = 0; s < q.sym; s++) {
      const ang = (2 * Math.PI * s) / q.sym;
      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);
      const positions = new Float32Array(NP * 3);
      const colors = new Float32Array(NP * 3);
      const tmp = new THREE.Color();
      const angleHues = new Float32Array(NP);
      for (let i = 0; i < NP; i++) {
        const t = i * dt;
        let pt;
        if (q.mode === "fourier") {
          const tip = fourierTip(fourierRef.current.coeffs, q.numCircles, t);
          pt = { x: tip.x - CANVAS_SIZE / 2, y: tip.y - CANVAS_SIZE / 2 };
        } else {
          pt = curvePoint(q.mode, t, q.p, q.outer);
        }
        const z = q.zAmp * Math.sin((2 * Math.PI * zCycles * t) / totalT);
        positions[i * 3] = (pt.x * cosA - pt.y * sinA) * nestS;
        positions[i * 3 + 1] = (pt.x * sinA + pt.y * cosA) * nestS;
        positions[i * 3 + 2] = z * nestS;
        angleHues[i] = rainbowPhase(q.mode, t, q.p, q.outer);
      }
      // 速度(隣接点間の距離)を計算
      let vMax = 1e-6;
      let vMin = Infinity;
      const speeds = new Float32Array(NP);
      for (let i = 1; i < NP; i++) {
        const dx = positions[i * 3] - positions[(i - 1) * 3];
        const dy = positions[i * 3 + 1] - positions[(i - 1) * 3 + 1];
        const dz = positions[i * 3 + 2] - positions[(i - 1) * 3 + 2];
        const v = Math.sqrt(dx * dx + dy * dy + dz * dz);
        speeds[i] = v;
        if (v > vMax) vMax = v;
        if (v < vMin) vMin = v;
      }
      speeds[0] = speeds[1] || 0;
      const vFloor = speedFloor(Number.isFinite(vMin) ? vMin : 0, vMax);
      for (let i = 0; i < NP; i++) {
        let c = baseColor;
        if (q.penMode === "angle") {
          const rc = rainbowColorAt(q.rainbowStyle, angleHues[i]);
          c = tmp.setHSL(rc.h / 360, rc.s / 100, rc.l / 100);
        } else if (q.penMode === "speed") {
          const rc2 = rampColorAt(q.rainbowStyle, normSpeed(speeds[i], vFloor, vMax));
          c = tmp.setHSL(rc2.h / 360, rc2.s / 100, rc2.l / 100);
        }
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geo.setDrawRange(0, 0);
      const mat = new THREE.LineBasicMaterial({ vertexColors: true });
      const line = new THREE.Line(geo, mat);
      three.group.add(line);
      lines.push(line);

      // 3軸対称: 同じ曲線をXY・XZ・YZの3平面に90°回転して配置
      if (q.mirror3d) {
        const transforms = [
          (x, y, z) => [x, -z, y], // X軸まわりに90°回転 → XZ平面
          (x, y, z) => [z, y, -x], // Y軸まわりに90°回転 → YZ平面
        ];
        transforms.forEach((tf) => {
          const pos2 = new Float32Array(NP * 3);
          for (let j = 0; j < NP; j++) {
            const [nx, ny, nz] = tf(
              positions[j * 3],
              positions[j * 3 + 1],
              positions[j * 3 + 2]
            );
            pos2[j * 3] = nx;
            pos2[j * 3 + 1] = ny;
            pos2[j * 3 + 2] = nz;
          }
          const geo2 = new THREE.BufferGeometry();
          geo2.setAttribute("position", new THREE.BufferAttribute(pos2, 3));
          geo2.setAttribute("color", new THREE.BufferAttribute(colors.slice(), 3));
          geo2.setDrawRange(0, 0);
          const line2 = new THREE.Line(geo2, new THREE.LineBasicMaterial({ vertexColors: true }));
          three.group.add(line2);
          lines.push(line2);
        });
      }
    }
    }
    three.draws.push({ lines, count: NP, progress: 0, done: false });
    stateRef.current.running3D = true;
    setDrawing(true);
    if (withRecord) startRecording(three.renderer.domElement);
  };

  // ---- 2D描画開始 ----
  const startDraw2D = (withRecord) => {
    if (!canvasRef.current) return;
    const q0 = params.current;
    const totalT = totalRange(q0.mode, q0.p, q0.outer);
    const st = stateRef.current;
    st.t = 0;
    st.prev = [];
    st.firstPts = null;
    st.lastRaw = null;
    st.running = true;
    const myGen = st.gen || 0; // このループの世代
    setDrawing(true);
    if (withRecord) startRecording(canvasRef.current);

    const cx = CANVAS_SIZE / 2;
    const cy = CANVAS_SIZE / 2;
    // 曲線がキャンバスに収まるよう自動フィット(はみ出す場合のみ縮小)
    const reach = maxReach(q0.mode, q0.p, q0.outer) * (q0.sym > 1 ? 1 : 1);
    const margin = CANVAS_SIZE / 2 - 12;
    const fit = reach > margin ? margin / reach : 1;
    st.fit = fit;

    // 速度ペン用: 事前に全体の速度分布を計算し、正規化の基準を確定させる
    // (最初の点からいきなり赤にならないように)
    if (q0.penMode === "speed") {
      const samples = 1200;
      const sdt = totalT / samples;
      let vMax = 1e-6;
      let vMin = Infinity;
      let prev = curvePoint(q0.mode, 0, q0.p, q0.outer);
      for (let i = 1; i <= samples; i++) {
        const cur = curvePoint(q0.mode, i * sdt, q0.p, q0.outer);
        // 刻み幅で割り「単位時間あたりの速さ」にする(描画側の刻みと無関係にする)
        const v = Math.hypot(cur.x - prev.x, cur.y - prev.y) / sdt;
        if (v > vMax) vMax = v;
        if (v < vMin) vMin = v;
        prev = cur;
      }
      st.vMax = Math.max(vMax, 1e-6);
      st.vFloor = speedFloor(Number.isFinite(vMin) ? vMin : 0, st.vMax);
    }

    const step = () => {
      if (!st.running || st.gen !== myGen) return; // 古い世代のループは自滅
      const ctx = getCtx();
      if (!ctx) return;
      const q = params.current;
      const dt = totalT / stepsFor(totalT);
      const stepsPerFrame = 12 * q.speed;

      ctx.lineWidth = q.width;
      ctx.lineCap = "round";

      for (let i = 0; i < stepsPerFrame; i++) {
        if (st.t > totalT) break;
        const pt = curvePoint(q.mode, st.t, q.p, q.outer);
        const progress = st.t / totalT;

        let strokeColor = q.color;
        if (q.penMode === "angle") {
          // 花びらの発生周期(R/r)に噛み合った回転で配色が一巡
          strokeColor = rainbowCSS(
            q.rainbowStyle,
            rainbowPhase(q.mode, st.t, q.p, q.outer)
          );
        } else if (q.penMode === "speed") {
          // 速度ペン: 事前計算した速度範囲で正規化(遅い=暗い→速い=明るい)
          const v = st.lastRaw
            ? Math.hypot(pt.x - st.lastRaw.x, pt.y - st.lastRaw.y) / dt
            : st.vFloor;
          strokeColor = rampCSS(q.rainbowStyle, normSpeed(v, st.vFloor, st.vMax));
          st.lastRaw = { x: pt.x, y: pt.y };
        }

        const N = q.sym;
        const F = st.fit;
        // ◎二重丸なら等倍と縮小版の2本、それ以外は1本
        const scales = nestScales(q.p && q.p.shape);
        const newPrev = [];
        ctx.strokeStyle = strokeColor;
        ctx.beginPath();
        for (let k = 0; k < scales.length; k++) {
          const ns = scales[k];
          for (let s = 0; s < N; s++) {
            const ang = (2 * Math.PI * s) / N;
            const x = cx + (pt.x * Math.cos(ang) - pt.y * Math.sin(ang)) * F * ns;
            const y = cy + (pt.x * Math.sin(ang) + pt.y * Math.cos(ang)) * F * ns;
            const idx = k * N + s;
            if (st.prev[idx]) {
              ctx.moveTo(st.prev[idx].x, st.prev[idx].y);
              ctx.lineTo(x, y);
            }
            newPrev.push({ x, y });
          }
        }
        ctx.stroke();
        // 曲線の始点を覚えておく(最後に閉じるため)
        if (!st.firstPts) st.firstPts = newPrev;
        st.prev = newPrev;
        st.t += dt;
      }

      if (st.t > totalT) {
        // 最後に始点へ戻る線を引いて曲線を閉じる。
        // 風車のような不連続な形は最後の切れ目で半径が飛ぶため、
        // これを描かないと1本ぶんの隙間が残ってしまう。
        if (st.firstPts && st.prev.length === st.firstPts.length) {
          ctx.beginPath();
          for (let s = 0; s < st.prev.length; s++) {
            ctx.moveTo(st.prev[s].x, st.prev[s].y);
            ctx.lineTo(st.firstPts[s].x, st.firstPts[s].y);
          }
          ctx.stroke();
        }
        stopDraw();
        return;
      }
      animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  };

  // ---- フーリエ描画 ----
  const startDrawFourier = (withRecord) => {
    const F = fourierRef.current;
    if (!F.coeffs || !canvasRef.current) return;
    const st = stateRef.current;
    st.ft = 0;
    st.lastRaw = null;
    st.running = true;
    const myGen = st.gen || 0;
    F.trace = [];
    // 速度ペン用に速度範囲を先に計算
    {
      const q0 = params.current;
      const samples = 1500;
      const sdt = (2 * Math.PI) / samples;
      let vMax = 1e-6;
      let vMin = Infinity;
      let prev = fourierTip(F.coeffs, q0.numCircles, 0);
      for (let i = 1; i <= samples; i++) {
        const cur = fourierTip(F.coeffs, q0.numCircles, i * sdt);
        const v = Math.hypot(cur.x - prev.x, cur.y - prev.y) / sdt;
        if (v > vMax) vMax = v;
        if (v < vMin) vMin = v;
        prev = cur;
      }
      st.vMax = Math.max(vMax, 1e-6);
      st.vFloor = speedFloor(Number.isFinite(vMin) ? vMin : 0, st.vMax);
    }
    setDrawing(true);
    if (withRecord) startRecording(canvasRef.current);

    const step = () => {
      if (!st.running || st.gen !== myGen) return; // 古い世代のループは自滅
      const ctx = getCtx();
      if (!ctx) return;
      const q = params.current;
      const dtF = 0.0016 * q.speed;
      const SUB = 4;
      for (let s = 0; s < SUB; s++) {
        st.ft += dtF;
        const tip = fourierTip(F.coeffs, q.numCircles, st.ft);
        let col = q.color;
        if (q.penMode === "angle") {
          // 図形1巡で配色が一巡
          col = rainbowCSS(q.rainbowStyle, (st.ft % (2 * Math.PI)) / (2 * Math.PI));
        } else if (q.penMode === "speed") {
          const v = st.lastRaw
            ? Math.hypot(tip.x - st.lastRaw.x, tip.y - st.lastRaw.y) / dtF
            : st.vFloor;
          col = rampCSS(q.rainbowStyle, normSpeed(v, st.vFloor, st.vMax));
          st.lastRaw = { x: tip.x, y: tip.y };
        }
        F.trace.push({ x: tip.x, y: tip.y, c: col });
        const maxLen = Math.ceil((2 * Math.PI) / dtF) + 2;
        if (F.trace.length > maxLen) F.trace.splice(0, F.trace.length - maxLen);
      }

      // フレーム描画: 背景 → 円の機構 → 軌跡
      const q2 = params.current;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

      // 機構(回転する円たち)
      let mx = 0, my = 0;
      const nC = Math.min(q2.numCircles, F.coeffs.length);
      ctx.lineWidth = 1;
      for (let i = 0; i < nC; i++) {
        const c = F.coeffs[i];
        const nx = mx + c.amp * Math.cos(c.freq * st.ft + c.phase);
        const ny = my + c.amp * Math.sin(c.freq * st.ft + c.phase);
        if (i > 0 && c.amp > 2.5) {
          ctx.strokeStyle = "#2c3552";
          ctx.beginPath();
          ctx.arc(mx, my, c.amp, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.strokeStyle = "#4a5578";
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(nx, ny);
          ctx.stroke();
        }
        mx = nx;
        my = ny;
      }

      // 軌跡(同じ色が続く区間をまとめて描画)
      ctx.lineWidth = q2.width;
      ctx.lineCap = "round";
      const tr = F.trace;
      let i0 = 1;
      while (i0 < tr.length) {
        const col = tr[i0].c;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(tr[i0 - 1].x, tr[i0 - 1].y);
        let i1 = i0;
        while (i1 < tr.length && tr[i1].c === col) {
          ctx.lineTo(tr[i1].x, tr[i1].y);
          i1++;
        }
        ctx.stroke();
        i0 = i1;
      }

      // ペン先
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(mx, my, 3, 0, 2 * Math.PI);
      ctx.fill();

      animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  };

  // ---- フーリエ: 指での図形入力 ----
  const canvasPos = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_SIZE,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_SIZE,
    };
  };
  const sketchDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    stopDraw();
    setView({ scale: 1, x: 0, y: 0 });
    const F = fourierRef.current;
    F.raw = [canvasPos(e)];
    stateRef.current.sketching = true;
    stateRef.current.sketchTarget = sketchModeRef.current;
    const ctx = getCtx();
    if (ctx) {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    }
  };
  const sketchMove = (e) => {
    const st = stateRef.current;
    if (!st.sketching) return;
    const F = fourierRef.current;
    const pt = canvasPos(e);
    const last = F.raw[F.raw.length - 1];
    if (Math.hypot(pt.x - last.x, pt.y - last.y) < 2) return;
    F.raw.push(pt);
    const ctx = getCtx();
    if (ctx) {
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
    }
  };
  // ---- 2Dキャンバスのピンチズーム・ドラッグパン ----
  const viewPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const g = viewGestureRef.current || { pts: new Map(), start: null };
    g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pts.size === 1) {
      g.start = { view: { ...view }, x: e.clientX, y: e.clientY };
    } else if (g.pts.size === 2) {
      const [p1, p2] = [...g.pts.values()];
      g.pinchStart = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      g.scaleStart = view.scale;
      g.midStart = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      g.viewStart = { ...view };
    }
    viewGestureRef.current = g;
  };
  const viewPointerMove = (e) => {
    const g = viewGestureRef.current;
    if (!g || !g.pts.has(e.pointerId)) return;
    g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pts.size === 1 && g.start) {
      setView((v) => ({
        ...v,
        x: g.start.view.x + (e.clientX - g.start.x),
        y: g.start.view.y + (e.clientY - g.start.y),
      }));
    } else if (g.pts.size === 2 && g.pinchStart) {
      const [p1, p2] = [...g.pts.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const ratio = dist / g.pinchStart;
      const scale = Math.max(0.4, Math.min(6, g.scaleStart * ratio));
      setView({ scale, x: g.viewStart.x, y: g.viewStart.y });
    }
  };
  const viewPointerUp = (e) => {
    const g = viewGestureRef.current;
    if (!g) return;
    g.pts.delete(e.pointerId);
    if (g.pts.size === 0) {
      viewGestureRef.current = null;
    } else if (g.pts.size === 1) {
      const [only] = [...g.pts.entries()];
      g.start = { view: { ...view }, x: only[1].x, y: only[1].y };
      g.pinchStart = null;
    }
  };

  const sketchUp = () => {
    const st = stateRef.current;
    if (!st.sketching) return;
    st.sketching = false;
    const F = fourierRef.current;
    if (F.raw.length < 8) return;
    if (st.sketchTarget === "gear") {
      // 手書きギア: 輪郭を半径テーブル化して固定ギアにする
      const tbl = buildGearTable(F.raw);
      if (tbl) {
        CUSTOM_GEAR.table = tbl;
        setHasGear(true);
        setShape("custom");
      }
      setSketchMode(null);
      setTimeout(() => startDraw(false), 30);
      return;
    }
    const sampled = resamplePath(F.raw, 512);
    F.coeffs = fourierCoeffs(sampled, 64);
    setHasShape(true);
    setSketchMode(null); // 入力完了 → 表示モードへ
    startDrawFourier(false);
  };

  // ランダムなフーリエ係数(有機的なランダム図形)
  const randomFourierShape = () => {
    const coeffs = [
      { freq: 0, amp: Math.hypot(CANVAS_SIZE / 2, CANVAS_SIZE / 2), phase: Math.atan2(CANVAS_SIZE / 2, CANVAS_SIZE / 2) },
    ];
    for (let k = 1; k <= 14; k++) {
      const f = Math.random() < 0.5 ? k : -k;
      coeffs.push({
        freq: f,
        amp: (170 / Math.pow(k, 1.35)) * (0.25 + Math.random() * 0.75),
        phase: Math.random() * 2 * Math.PI,
      });
    }
    coeffs.sort((a, b) => b.amp - a.amp);
    fourierRef.current.coeffs = coeffs;
    setHasShape(true);
  };

  // 描画開始前の下ごしらえ。重ね描きOFF(既定)なら消してから描き直す
  const prepareCanvas = (force) => {
    if (!force && overlayRef.current) return;
    if (is3DRef.current) {
      if (threeRef.current) {
        const { group, draws } = threeRef.current;
        draws.forEach((dr) =>
          dr.lines.forEach((ln) => {
            group.remove(ln);
            ln.geometry.dispose();
            ln.material.dispose();
          })
        );
        threeRef.current.draws = [];
      }
    } else {
      const ctx = getCtx();
      if (ctx) {
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      }
    }
  };

  const startDraw = (withRecord = false, forceClear = false) => {
    stopDraw();
    // 描き始めたら設定は決まったとみなしてチップを畳む
    setShowRandOpts(false);
    prepareCanvas(forceClear);
    if (is3DRef.current) {
      // 3Dシーンのマウントが終わっていなければ少し待ってリトライ
      if (!threeRef.current) {
        let tries = 0;
        const wait = () => {
          if (threeRef.current) {
            startDraw3D(withRecord);
          } else if (tries++ < 10) {
            setTimeout(wait, 100);
          }
        };
        setTimeout(wait, 100);
        return;
      }
      startDraw3D(withRecord);
    } else if (params.current.mode === "fourier") {
      startDrawFourier(withRecord);
    } else {
      startDraw2D(withRecord);
    }
  };

  const applyPreset = (ps) => {
    stopDraw();
    const s = ps.s;
    if ("is3D" in s) setIs3D(s.is3D);
    if ("mode" in s) setMode(s.mode);
    if ("R" in s) setR(s.R);
    if ("r" in s) setr(s.r);
    if ("d" in s) setd(s.d);
    if ("outer" in s) setOuter(s.outer);
    if ("shape" in s) setShape(s.shape);
    if ("chain" in s) setChain(s.chain);
    if ("concaveFlip" in s) setConcaveFlip(s.concaveFlip);
    if ("penReverse" in s) setPenReverse(s.penReverse);
    if ("r2" in s) setR2(s.r2);
    if ("la" in s) setLa(s.la);
    if ("lb" in s) setLb(s.lb);
    if ("phase" in s) setPhase(s.phase);
    if ("rn" in s) setRn(s.rn);
    if ("rm" in s) setRm(s.rm);
    if ("rA" in s) setRA(s.rA);
    if ("sym" in s) setSym(s.sym);
    if ("penMode" in s) setPenMode(s.penMode);
    if ("rainbowStyle" in s) setRainbowStyle(s.rainbowStyle);
    if ("width" in s) setWidth(s.width);
    if ("color" in s) setColor(s.color);
    if ("zAmp" in s) setZAmp(s.zAmp);
    if ("zRatio" in s) setZRatio(s.zRatio);
    if ("mirror3d" in s) setMirror3d(s.mirror3d);
    setTimeout(() => startDraw(false), 150);
  };

  const randomize = () => {
    // アイコンモード: 疎なパラメータだけを生成する
    if (iconMode) {
      const kinds = ["spiro", "spiro", "spiro", "rose", "lissajous"];
      const k = kinds[Math.floor(Math.random() * kinds.length)];
      setMode(k);
      setChain(false);
      if (k === "spiro") {
        const p = randomSpiroParams(true);
        setR(p.R);
        setr(p.r);
        setd(p.d);
        if (!lockOpts.dir) setOuter(Math.random() < 0.25);
        if (!lockOpts.shape) {
          const shapes = ["circle", "circle", "circle", "square", "triangle", "star", "reuleaux"];
          setShape(shapes[Math.floor(Math.random() * shapes.length)]);
        }
      } else if (k === "rose") {
        const n = 2 + Math.floor(Math.random() * 6);
        setRn(n);
        setRm(1);
        setRA(200);
      } else {
        const [a, b] = randomCoprimePair(4);
        setLa(a);
        setLb(b);
        setPhase(90);
      }
      if (!lockOpts.sym) setSym(Math.random() < 0.5 ? SYMMETRIES[1 + Math.floor(Math.random() * 3)] : 1);
      setShowRandOpts(false);
      return;
    }

    if (mode === "fourier") {
      stopDraw();
      setSketchMode(null);
      randomFourierShape();
      setTimeout(() => startDraw(false), 30);
      return;
    }
    if (mode === "spiro") {
      if (!lockOpts.size) {
        const p = randomSpiroParams(false);
        setR(p.R);
        setr(p.r);
        setd(p.d);
      }
      if (!lockOpts.dir) {
        setOuter(Math.random() < 0.3);
        const useChain = Math.random() < 0.25;
        setChain(useChain);
        if (useChain) setR2(8 + Math.floor(Math.random() * 40));
      }
      if (!lockOpts.shape) {
        // 手書きギアは作っていない場合があるので候補から外す
        const shapes = [
          "circle",
          "circle",
          "circle",
          ...SHAPES.filter((s) => s.id !== "custom").map((s) => s.id),
        ];
        setShape(shapes[Math.floor(Math.random() * shapes.length)]);
      }
    } else if (mode === "lissajous") {
      if (!lockOpts.size) {
        const [a, b] = randomCoprimePair(8);
        setLa(a);
        setLb(b);
        setPhase(Math.floor(Math.random() * 181));
      }
    } else {
      // ローズ: n/m を互いに素にして、閉じるまでの回転数を抑える
      if (!lockOpts.size) {
        const [n, m] = randomCoprimePair(9);
        setRn(n);
        setRm(Math.min(m, 5));
      }
    }
    if (is3D && !lockOpts.zwave) {
      setZAmp(40 + Math.floor(Math.random() * 160));
      setZRatio(Z_RATIOS[Math.floor(Math.random() * Z_RATIOS.length)].v);
    }
    if (!lockOpts.sym) setSym(SYMMETRIES[Math.floor(Math.random() * SYMMETRIES.length)]);
    if (!lockOpts.color) {
      if (penMode === "solid") {
        setColor(PEN_COLORS[Math.floor(Math.random() * PEN_COLORS.length)].hex);
      } else {
        setRainbowStyle(RAINBOW_STYLES[Math.floor(Math.random() * RAINBOW_STYLES.length)].id);
      }
    }
    setTimeout(() => startDraw(false), 30);
  };

  const savePNG = () => {
    const c = is3D ? threeRef.current?.renderer.domElement : canvasRef.current;
    if (!c) return;
    const a = document.createElement("a");
    a.download = "spirograph.png";
    a.href = c.toDataURL("image/png");
    a.click();
  };

  const accent =
    penMode === "angle"
      ? rainbowCSS(rainbowStyle, 0.62)
      : penMode === "speed"
      ? rampCSS(rainbowStyle, 0.85)
      : color;

  const Slider = ({ label, value, min, max, step = 1, onChange, unit = "" }) => (
    <div className="mb-3">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-[11px] tracking-widest text-slate-400 uppercase">{label}</span>
        <span className="font-mono text-sm tabular-nums" style={{ color: accent }}>
          {value}{unit}
        </span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-2 rounded appearance-none cursor-pointer bg-slate-700"
        style={{ accentColor: accent, touchAction: "none" }}
      />
    </div>
  );

  useEffect(() => {
    sketchModeRef.current = sketchMode;
  }, [sketchMode]);

  // 2D/3D・モードを切り替えたら自動で描き始める(フーリエのスケッチ待ち等は除く)
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    // アイコンモードは専用の静止画描画に任せる
    if (iconMode) return;
    // フーリエで図形が未入力なら描かない(スケッチ待ち)
    if (mode === "fourier" && !hasShape) return;
    stopDraw();
    // モードが変わったら別種の曲線になるので、重ね描き設定に関わらず消してから描く
    const id = setTimeout(() => startDraw(false, true), is3D ? 260 : 60);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3D, mode, iconMode]);

  // フーリエモードに入ったとき、図形がなければ自動でスケッチモードへ
  useEffect(() => {
    if (mode === "fourier" && !is3D && !hasShape) setSketchMode("fourier");
    else if (mode !== "fourier" && sketchMode === "fourier") setSketchMode(null);
  }, [mode, is3D, hasShape, sketchMode]);

  // 2Dキャンバス上のスワイプでページがスクロールしないよう抑止(スケッチ・ズーム両方)
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || is3D) return;
    const block = (e) => e.preventDefault();
    el.addEventListener("touchstart", block, { passive: false });
    el.addEventListener("touchmove", block, { passive: false });
    return () => {
      el.removeEventListener("touchstart", block);
      el.removeEventListener("touchmove", block);
    };
  }, [is3D, sketchMode]);

  // アイコンモード: パラメータが変わるたびに即座に静止画として描き直す
  const prevIconModeRef = useRef(false);
  useEffect(() => {
    const wasIcon = prevIconModeRef.current;
    prevIconModeRef.current = iconMode;
    if (is3D) return;
    if (!iconMode) {
      // アイコンモードを「抜けた瞬間」だけ市松模様を消す。
      // ここで毎回消すと、重ね描きONでもパラメータ変更のたびに絵が消えてしまう
      if (wasIcon) {
        const ctx = getCtx();
        if (ctx) {
          ctx.fillStyle = BG;
          ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        }
      }
      return;
    }
    stopDraw();
    const q = params.current;
    const ctx = getCtx();
    if (ctx) {
      // 透過を活かすため市松模様の下地を描いてから曲線を重ねる
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      const sq = 24;
      for (let y = 0; y < CANVAS_SIZE; y += sq) {
        for (let x = 0; x < CANVAS_SIZE; x += sq) {
          ctx.fillStyle = ((x / sq + y / sq) % 2 === 0) ? "#171c30" : "#131728";
          ctx.fillRect(x, y, sq, sq);
        }
      }
      const scale = CANVAS_SIZE / 200; // プレビュー200px想定の線幅を実寸に換算
      renderIconKeepBg(ctx, q, CANVAS_SIZE, iconWidth * scale, iconColor);
    }
    // 小サイズプレビュー(64 / 32 / 16px)
    [64, 32, 16].forEach((sz, i) => {
      const c = iconPreviewRefs.current[i];
      if (!c) return;
      const pctx = c.getContext("2d");
      renderIcon(pctx, q.mode, q.p, q.outer, q.sym, sz, (iconWidth * sz) / 200, iconColor);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iconMode, is3D, mode, R, r, d, outer, shape, chain, concaveFlip, penReverse, r2, la, lb, phase, rn, rm, rA, sym, iconWidth, iconColor]);

  // ---- アイコン書き出し ----
  const downloadBlob = (blob, filename) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const saveIconSVG = () => {
    const q = params.current;
    const svg = iconToSVG(q.mode, q.p, q.outer, q.sym, 512, (iconWidth * 512) / 200, iconColor);
    downloadBlob(new Blob([svg], { type: "image/svg+xml" }), "icon.svg");
  };

  const saveIconPNG = (size) => {
    const q = params.current;
    const off = document.createElement("canvas");
    off.width = size;
    off.height = size;
    const octx = off.getContext("2d");
    renderIcon(octx, q.mode, q.p, q.outer, q.sym, size, (iconWidth * size) / 200, iconColor);
    off.toBlob((b) => b && downloadBlob(b, "icon-" + size + ".png"), "image/png");
  };

  const applyIconPreset = (ps) => {
    const s = ps.s;
    setMode(s.mode);
    if ("R" in s) setR(s.R);
    if ("r" in s) setr(s.r);
    if ("d" in s) setd(s.d);
    if ("outer" in s) setOuter(s.outer);
    if ("shape" in s) setShape(s.shape);
    if ("n" in s) setRn(s.n);
    if ("m" in s) setRm(s.m);
    if ("A" in s) setRA(s.A);
    if ("a" in s) setLa(s.a);
    if ("b" in s) setLb(s.b);
    if ("phase" in s) setPhase(s.phase);
    setChain(false);
  };

  const SectionHeader = ({ id, label, hint }) => (
    <button
      onClick={() => toggle(id)}
      className="w-full flex items-center justify-between py-2 border-t border-slate-800 mt-1"
    >
      <span className="text-[11px] tracking-widest text-slate-400 uppercase">
        {label}
        {hint && !open[id] && (
          <span className="ml-2 normal-case tracking-normal text-slate-600">{hint}</span>
        )}
      </span>
      <span
        className="text-[10px]"
        style={{
          color: accent,
          display: "inline-block",
          transform: open[id] ? "rotate(90deg)" : "none",
        }}
      >
        ▶
      </span>
    </button>
  );

  return (
    <div
      className={
        "min-h-screen flex " +
        (isLandscape
          ? "flex-row items-start justify-center p-2 gap-3"
          : "flex-col items-center p-3 gap-4")
      }
      style={{ background: "#080a16", fontFamily: "'Segoe UI', system-ui, sans-serif" }}
    >
      {/* 表示エリア */}
      <div
        className={"rounded-2xl relative " + (isLandscape ? "shrink-0" : "w-full max-w-md")}
        style={{
          boxShadow: "0 0 50px " + accent + "22, 0 16px 40px #00000088",
          overflow: is3D || sketchMode ? "hidden" : "clip",
          borderRadius: "1rem",
          // 横画面では画面の高さに合わせて正方形を収める
          width: isLandscape ? "min(calc(100dvh - 16px), 55vw)" : undefined,
          position: isLandscape ? "sticky" : "relative",
          top: isLandscape ? 8 : undefined,
        }}
      >
        {is3D ? (
          <div
            ref={mountRef}
            className="w-full aspect-square"
            style={{ touchAction: "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        ) : (
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            className="block w-full h-auto"
            style={{
              touchAction: "none",
              overscrollBehavior: "contain",
              transform:
                "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")",
              transformOrigin: "center center",
              transition: viewGestureRef.current ? "none" : "transform 0.08s ease-out",
            }}
            onPointerDown={sketchMode ? sketchDown : viewPointerDown}
            onPointerMove={sketchMode ? sketchMove : viewPointerMove}
            onPointerUp={sketchMode ? sketchUp : viewPointerUp}
            onPointerCancel={sketchMode ? sketchUp : viewPointerUp}
          />
        )}
        {!is3D && !sketchMode && (view.scale !== 1 || view.x !== 0 || view.y !== 0) && (
          <button
            onClick={() => setView({ scale: 1, x: 0, y: 0 })}
            className="absolute bottom-2 right-2 text-[10px] px-2 py-1 rounded-full bg-slate-800/90 text-slate-300 active:bg-slate-700"
          >
            リセット
          </button>
        )}
        {!is3D && sketchMode && (
          <>
            <div
              className="absolute inset-0 pointer-events-none rounded-2xl"
              style={{ border: "2px dashed " + accent + "99" }}
            />
            <span
              className="absolute top-2 left-3 text-[10px] font-semibold px-2 py-0.5 rounded-full pointer-events-none"
              style={{ background: accent, color: "#0d1021" }}
            >
              {sketchMode === "gear" ? "✍️ ギアを描く" : "✍️ 入力モード"}
            </span>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-sm text-slate-500 text-center px-6">
                {sketchMode === "gear"
                  ? "ギアの輪郭を一筆書き（この形の内側をペンが転がります）"
                  : "指で好きな形を一筆書きしてみて"}
              </span>
            </div>
          </>
        )}
        {is3D && (
          <span className="absolute bottom-2 left-3 text-[10px] text-slate-500 pointer-events-none">
            ドラッグで回転 / ピンチでズーム
          </span>
        )}
      </div>

      {/* コントロール */}
      <div
        className={
          "rounded-2xl p-4 bg-slate-900/80 border border-slate-800 " +
          (isLandscape ? "flex-1 min-w-0 overflow-y-auto" : "w-full max-w-md")
        }
        style={
          isLandscape
            ? { maxWidth: 400, maxHeight: "calc(100dvh - 16px)", overscrollBehavior: "contain" }
            : undefined
        }
      >
        {/* メインアクション(上部) */}
        {!iconMode && (
        <>
        <div className="grid grid-cols-3 gap-2 mb-2">
          <button
            onClick={() => (drawing ? stopDraw() : startDraw(false))}
            className="py-3 rounded-lg font-semibold text-sm"
            style={{ background: accent, color: "#0d1021" }}
          >
            {drawing ? "停止" : "描く"}
          </button>
          <div className="flex gap-1">
            <button
              onClick={randomize}
              className="flex-1 py-3 rounded-l-lg text-sm font-medium bg-slate-800 text-slate-300 active:bg-slate-700"
            >
              ランダム
            </button>
            <button
              onClick={() => setShowRandOpts((v) => !v)}
              title="ランダムで固定する項目を選ぶ"
              className="px-2 py-3 rounded-r-lg text-xs"
              style={{
                background: showRandOpts ? accent : "#1e293b",
                color: showRandOpts ? "#0d1021" : "#94a3b8",
              }}
            >
              ⚙
            </button>
          </div>
          <button
            onClick={() => setShowPresets((v) => !v)}
            className="py-3 rounded-lg text-sm font-medium border"
            style={{
              borderColor: showPresets ? accent : "#334155",
              background: showPresets ? accent : "#1e293b",
              color: showPresets ? "#0d1021" : "#cbd5e1",
            }}
          >
            おすすめ {showPresets ? "▴" : "▾"}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          <button
            onClick={clearCanvas}
            className="py-2.5 rounded-lg text-sm font-medium bg-slate-800 text-slate-300 active:bg-slate-700"
          >
            クリア
          </button>
          <button
            onClick={savePNG}
            className="py-2.5 rounded-lg text-sm font-medium bg-slate-800 text-slate-300 active:bg-slate-700"
          >
            🖼 PNG
          </button>
          <button
            onClick={() => (drawing ? stopDraw() : startDraw(true))}
            className="py-2.5 rounded-lg font-semibold text-sm border"
            style={{
              borderColor: accent,
              color: recording ? "#0d1021" : accent,
              background: recording ? accent : "transparent",
            }}
          >
            {recording ? "録画中…" : "🎥 録画"}
          </button>
        </div>

        {/* ランダムで変える項目 */}
        {showRandOpts && (
          <div className="mb-3 rounded-xl border border-slate-800 p-2.5">
            <span className="text-[10px] text-slate-500">
              🔒 を付けた項目はランダムでも今の設定を保ちます
            </span>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {[
                { k: "shape", label: "固定ギア", show: mode === "spiro" },
                {
                  k: "size",
                  label: mode === "spiro" ? "大きさ" : mode === "rose" ? "花びら" : "周波数",
                  show: mode !== "fourier",
                },
                { k: "dir", label: "内側·外側·連結", show: mode === "spiro" },
                { k: "zwave", label: "Z波", show: is3D },
                { k: "sym", label: "対称", show: true },
                { k: "color", label: "配色", show: true },
              ]
                .filter((o) => o.show)
                .map((o) => {
                  const locked = lockOpts[o.k];
                  return (
                    <button
                      key={o.k}
                      onClick={() => toggleLock(o.k)}
                      className="px-3 py-1.5 rounded-full text-[11px] font-semibold border"
                      style={{
                        borderColor: locked ? accent : "#334155",
                        background: locked ? accent : "transparent",
                        color: locked ? "#0d1021" : "#64748b",
                      }}
                    >
                      {locked ? "🔒 " : ""}
                      {o.label}
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        {/* 重ね描きトグル */}
        <button
          onClick={() => setOverlay((v) => !v)}
          className="w-full py-1.5 rounded-lg text-[11px] font-medium mb-3 border"
          style={{
            borderColor: overlay ? accent : "#334155",
            background: overlay ? accent + "22" : "transparent",
            color: overlay ? accent : "#64748b",
          }}
        >
          {overlay ? "🎨 重ね描き ON(消さずに重ねます)" : "🎨 重ね描き OFF(毎回描き直し)"}
        </button>

        {/* おすすめプリセット(ボタンで開閉) */}
        {showPresets && (
          <div className="mb-3 rounded-xl border border-slate-800 p-2">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((ps) => (
                <button
                  key={ps.name}
                  onClick={() => {
                    applyPreset(ps);
                    setShowPresets(false);
                  }}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-slate-800 text-slate-300 active:bg-slate-700 border border-slate-700"
                >
                  {ps.name}
                </button>
              ))}
            </div>
          </div>
        )}
        </>
        )}

        {/* 2D/3D + アイコン */}
        <div className="flex gap-1.5 mb-2">
          {["2D", "3D"].map((dim) => (
            <button
              key={dim}
              onClick={() => {
                stopDraw();
                setIconMode(false);
                if (dim === "3D" && !is3D) {
                  // 3Dに切り替えたときはZ波の花びら比率を1×に戻す
                  // (プリセットは独自の比率を持つので、そちらは上書きしない)
                  setZRatio(1);
                  // Z波の高さを図の大きさに比例させる。
                  // 固定値だと小さい図では縦長すぎ、大きい図では平坦に見えてしまうため、
                  // 曲線の最大到達半径に係数をかけて縦横の比率を揃える。
                  const q = params.current;
                  if (q && q.p) {
                    const reach = maxReach(q.mode, q.p, q.outer);
                    if (reach > 0) {
                      setZAmp(Math.max(0, Math.min(250, Math.round(reach * 0.35))));
                    }
                  }
                }
                setIs3D(dim === "3D");
              }}
              className="flex-1 py-2 rounded-lg text-xs font-bold"
              style={{
                background: !iconMode && (dim === "3D") === is3D ? accent : "#1e293b",
                color: !iconMode && (dim === "3D") === is3D ? "#0d1021" : "#94a3b8",
              }}
            >
              {dim}
            </button>
          ))}
          <button
            onClick={() => {
              stopDraw();
              setIs3D(false);
              const next = !iconMode;
              if (next) {
                if (mode === "fourier") setMode("spiro");
                // 密すぎる設定のままだと塗り潰しになるので、疎な形へ自動で寄せる
                const q = params.current;
                const revs = totalRange(q.mode, q.p, q.outer) / (2 * Math.PI);
                if (chain || revs > 6) applyIconPreset(ICON_PRESETS[2]);
              }
              setIconMode(next);
            }}
            className="flex-1 py-2 rounded-lg text-xs font-bold"
            style={{
              background: iconMode ? accent : "#1e293b",
              color: iconMode ? "#0d1021" : "#94a3b8",
            }}
          >
            ◆ アイコン
          </button>
        </div>
        <div className="flex gap-1.5 mb-4">
          {(iconMode ? MODES.filter((m) => m.id !== "fourier") : MODES).map((mo) => (
            <button
              key={mo.id}
              onClick={() => {
                stopDraw();
                setMode(mo.id);
              }}
              className="flex-1 py-2 rounded-lg text-xs font-semibold"
              style={{
                background: mode === mo.id ? accent : "#1e293b",
                color: mode === mo.id ? "#0d1021" : "#94a3b8",
              }}
            >
              {mo.label}
            </button>
          ))}
        </div>

        {/* アイコンモードのパネル */}
        {iconMode && (
          <div className="mb-4 rounded-xl border border-slate-800 p-3">
            {/* ランダム(最上部・押しやすく) */}
            <div className="flex gap-1 mb-3">
              <button
                onClick={randomize}
                className="flex-1 py-3 rounded-l-lg text-sm font-bold"
                style={{ background: accent, color: "#0d1021" }}
              >
                🎲 ランダムで形を作る
              </button>
              <button
                onClick={() => setShowRandOpts((v) => !v)}
                title="ランダムで固定する項目を選ぶ"
                className="px-3 py-3 rounded-r-lg text-xs"
                style={{
                  background: showRandOpts ? accent : "#1e293b",
                  color: showRandOpts ? "#0d1021" : "#94a3b8",
                }}
              >
                ⚙
              </button>
            </div>
            {showRandOpts && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {[
                  { k: "shape", label: "固定ギア" },
                  { k: "dir", label: "内側·外側·連結" },
                  { k: "sym", label: "対称" },
                ].map((o) => {
                  const locked = lockOpts[o.k];
                  return (
                    <button
                      key={o.k}
                      onClick={() => toggleLock(o.k)}
                      className="px-3 py-1.5 rounded-full text-[11px] font-semibold border"
                      style={{
                        borderColor: locked ? accent : "#334155",
                        background: locked ? accent : "transparent",
                        color: locked ? "#0d1021" : "#64748b",
                      }}
                    >
                      {locked ? "🔒 " : ""}
                      {o.label}
                    </button>
                  );
                })}
              </div>
            )}

            {/* 小サイズプレビュー */}
            <div className="flex items-end gap-4 mb-3">
              {[64, 32, 16].map((sz, i) => (
                <div key={sz} className="flex flex-col items-center gap-1">
                  <div
                    className="rounded"
                    style={{
                      background:
                        "repeating-conic-gradient(#171c30 0% 25%, #131728 0% 50%) 50%/12px 12px",
                      padding: 2,
                    }}
                  >
                    <canvas
                      ref={(el) => (iconPreviewRefs.current[i] = el)}
                      width={sz}
                      height={sz}
                      style={{ display: "block", width: sz, height: sz }}
                    />
                  </div>
                  <span className="text-[9px] text-slate-500">{sz}px</span>
                </div>
              ))}
              <span className="text-[10px] text-slate-600 leading-tight pb-4">
                小さくして
                <br />
                潰れないか確認
              </span>
            </div>

            {(() => {
              const q = params.current;
              const revs = Math.round(totalRange(q.mode, q.p, q.outer) / (2 * Math.PI));
              return revs > 6 ? (
                <p className="text-[10px] mb-2 leading-relaxed" style={{ color: "#ffb347" }}>
                  ⚠ {revs}回転で閉じる密な曲線です。小さくすると潰れるので、下の「形」から選ぶか
                  R:r をきりのいい比({q.mode === "spiro" ? "3:1, 4:1, 5:2 など" : "小さい整数比"})にしてください。
                </p>
              ) : null;
            })()}

            {/* アイコン向けプリセット */}
            <span className="text-[11px] tracking-widest text-slate-400 uppercase">形</span>
            <div className="flex gap-1.5 mt-1 mb-3 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
              {ICON_PRESETS.map((ps) => (
                <button
                  key={ps.name}
                  onClick={() => applyIconPreset(ps)}
                  className="shrink-0 px-2.5 py-1.5 rounded-full text-[11px] font-medium bg-slate-800 text-slate-300 active:bg-slate-700 border border-slate-700"
                >
                  {ps.name}
                </button>
              ))}
            </div>

            <Slider label="線の太さ" value={iconWidth} min={4} max={40} onChange={setIconWidth} />

            {/* 色 */}
            <div className="flex gap-2 mb-3 items-center flex-wrap">
              {["#f2f2f2", "#0d1021", "#ff4d6d", "#ffb347", "#9bec5b", "#4dd8ff", "#b388ff"].map((c) => (
                <button
                  key={c}
                  onClick={() => setIconColor(c)}
                  className="w-8 h-8 rounded-full border border-slate-700"
                  style={{
                    background: c,
                    transform: iconColor === c ? "scale(1.15)" : "scale(1)",
                    outline: iconColor === c ? "2px solid #ffffff66" : "none",
                    outlineOffset: "3px",
                  }}
                />
              ))}
            </div>

            {/* 書き出し */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={saveIconSVG}
                className="py-2.5 rounded-lg text-xs font-semibold"
                style={{ background: accent, color: "#0d1021" }}
              >
                SVG保存(推奨)
              </button>
              <button
                onClick={() => saveIconPNG(1024)}
                className="py-2.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 active:bg-slate-700"
              >
                透過PNG 1024px
              </button>
            </div>
            <p className="text-[10px] text-slate-600 mt-2 leading-relaxed">
              背景の市松模様は透過を表しています。アイコンは拡大縮小に強いSVGでの保存がおすすめ。対称やギア形状はパラメータ側で調整できます。
            </p>
          </div>
        )}

        {/* ペン + 配色(横並び) */}
        {!iconMode && (
        <div className="flex gap-3 mb-4 items-center">
        <div className="flex gap-2 items-center shrink-0">
          <button
            title="虹ペン(花びらの周期に合わせて虹が一巡)・既定"
            onClick={() => setPenMode(penMode === "angle" ? "solid" : "angle")}
            className="w-9 h-9 rounded-full"
            style={{
              background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
              transform: penMode === "angle" ? "scale(1.2)" : "scale(1)",
              outline: penMode === "angle" ? "2px solid #ffffff66" : "none",
              outlineOffset: "3px",
            }}
          />
          <button
            title="速度ペン(暗い=遅い→明るい=速い)"
            onClick={() => setPenMode(penMode === "speed" ? "solid" : "speed")}
            className="w-9 h-9 rounded-full flex items-center justify-center text-xs"
            style={{
              // 既定配色(ビビッド)の速度ランプに合わせる
              background:
                "linear-gradient(135deg," +
                [0, 0.16, 0.34, 0.52, 0.68, 0.82, 0.92, 1]
                  .map((u) => rampCSS("vivid", u))
                  .join(",") +
                ")",
              transform: penMode === "speed" ? "scale(1.2)" : "scale(1)",
              outline: penMode === "speed" ? "2px solid #ffffff66" : "none",
              outlineOffset: "3px",
            }}
          >
            ⚡
          </button>
          <button
            title="単色ペン(タップで色を選択)"
            onClick={() => {
              if (penMode === "solid") {
                setShowSolidPicker((v) => !v);
              } else {
                setPenMode("solid");
                setShowSolidPicker(true);
              }
            }}
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{
              background: color,
              transform: penMode === "solid" ? "scale(1.2)" : "scale(1)",
              outline: penMode === "solid" ? "2px solid #ffffff66" : "none",
              outlineOffset: "3px",
            }}
          >
            <span className="text-[10px]" style={{ color: "#0d102188" }}>▾</span>
          </button>
        </div>

        {/* 虹ペンの配色 */}
        {(penMode === "angle" || penMode === "speed") && (
          <div
            className="flex gap-1.5 overflow-x-auto pb-1 min-w-0"
            style={{ scrollbarWidth: "none" }}
          >
            {RAINBOW_STYLES.map((rs) => {
              const on = rainbowStyle === rs.id;
              const stops = [0, 0.2, 0.4, 0.6, 0.8, 1]
                .map((u) => (penMode === "speed" ? rampCSS(rs.id, u) : rainbowCSS(rs.id, u)))
                .join(",");
              return (
                <button
                  key={rs.id}
                  onClick={() => setRainbowStyle(rs.id)}
                  className="shrink-0 rounded-full overflow-hidden"
                  style={{
                    border: on ? "2px solid #ffffff" : "1px solid #334155",
                    boxShadow: on ? "0 0 10px #ffffff55" : "none",
                    transform: on ? "scale(1.08)" : "scale(1)",
                    opacity: on ? 1 : 0.62,
                  }}
                >
                  <span
                    className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold whitespace-nowrap"
                    style={{
                      background: "linear-gradient(90deg," + stops + ")",
                      color: "#0d1021",
                    }}
                  >
                    {on && <span>✓</span>}
                    {rs.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        </div>
        )}

        {/* 単色の色パレット(単色ペン選択中にタップで開閉) */}
        {!iconMode && penMode === "solid" && showSolidPicker && (
          <div className="mb-4 -mt-2">
            <span className="text-[11px] tracking-widest text-slate-400 uppercase">色</span>
            <div className="flex gap-2 mt-1 items-center flex-wrap">
              {PEN_COLORS.map((c) => (
                <button
                  key={c.hex}
                  title={c.name}
                  onClick={() => {
                    setColor(c.hex);
                    setShowSolidPicker(false);
                  }}
                  className="w-8 h-8 rounded-full transition-transform"
                  style={{
                    background: c.hex,
                    transform: color === c.hex ? "scale(1.2)" : "scale(1)",
                    outline: color === c.hex ? "2px solid #ffffffaa" : "none",
                    outlineOffset: "3px",
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* 単色の色パレット(単色ペン選択中にタップで開閉) */}
        {!iconMode && penMode === "solid" && showSolidPicker && (
          <div className="mb-4 -mt-2">
            <span className="text-[11px] tracking-widest text-slate-400 uppercase">色</span>
            <div className="flex gap-2 mt-1 items-center flex-wrap">
              {PEN_COLORS.map((c) => (
                <button
                  key={c.hex}
                  title={c.name}
                  onClick={() => {
                    setColor(c.hex);
                    setShowSolidPicker(false);
                  }}
                  className="w-8 h-8 rounded-full transition-transform"
                  style={{
                    background: c.hex,
                    transform: color === c.hex ? "scale(1.2)" : "scale(1)",
                    outline: color === c.hex ? "2px solid #ffffffaa" : "none",
                    outlineOffset: "3px",
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* --- パラメータ(折りたたみ) --- */}
        <SectionHeader id="params" label="パラメータ" hint={MODES.find((m) => m.id === mode)?.label} />
        {open.params && (<>

        {/* 3Dではギアの形・大きさ・転がり方は隠す(変更したいときは2Dに戻して調整する) */}
        {mode === "spiro" && !is3D && (
          <>
            {/* ペンの回転まわり */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setPenReverse(!penReverse)}
                className="flex-1 py-2 rounded-lg text-xs font-medium border"
                style={{
                  borderColor: penReverse ? accent : "#334155",
                  background: penReverse ? accent + "22" : "transparent",
                  color: penReverse ? accent : "#64748b",
                }}
              >
                {penReverse ? "🔁 逆回転 ON" : "🔁 逆回転 OFF"}
              </button>
              {shape !== "circle" && shape !== "ellipse" && (
                <button
                  onClick={() => setConcaveFlip(!concaveFlip)}
                  className="flex-1 py-2 rounded-lg text-xs font-medium border"
                  style={{
                    borderColor: concaveFlip ? accent : "#334155",
                    background: concaveFlip ? accent + "22" : "transparent",
                    color: concaveFlip ? accent : "#64748b",
                  }}
                >
                  {concaveFlip ? "🔄 凹みで反転 ON" : "🔄 凹みで反転 OFF"}
                </button>
              )}
            </div>

            {/* ギア形状(プレビュー付き) */}
            <div className="mb-3">
              <span className="text-[11px] tracking-widest text-slate-400 uppercase">固定ギアの形</span>
              <div className="grid grid-cols-4 gap-1.5 mt-1">
                {SHAPES.map((sh) => {
                  const on = shape === sh.id;
                  const empty = sh.id === "custom" && !hasGear;
                  return (
                    <button
                      key={sh.id}
                      onClick={() => {
                        if (empty) {
                          // まだ手書きギアがない → 入力モードへ
                          stopDraw();
                          setSketchMode("gear");
                          const ctx = getCtx();
                          if (ctx) {
                            ctx.fillStyle = BG;
                            ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
                          }
                          return;
                        }
                        setShape(sh.id);
                      }}
                      className="flex flex-col items-center gap-0.5 py-1.5 rounded-lg"
                      style={{
                        background: on ? accent : "#1e293b",
                        opacity: empty ? 0.55 : 1,
                      }}
                    >
                      <svg viewBox="-1.2 -1.2 2.4 2.4" className="w-6 h-6">
                        <path
                          d={empty ? shapePath("circle") : shapePath(sh.id)}
                          fill="none"
                          stroke={on ? "#0d1021" : "#94a3b8"}
                          strokeWidth="0.16"
                          strokeLinejoin="round"
                          strokeDasharray={empty ? "0.2 0.2" : undefined}
                        />
                      </svg>
                      <span
                        className="text-[9px] leading-none"
                        style={{ color: on ? "#0d1021" : "#94a3b8" }}
                      >
                        {sh.label}
                      </span>
                    </button>
                  );
                })}
              </div>
              {!is3D && (
                <button
                  onClick={() => {
                    if (sketchMode === "gear") {
                      setSketchMode(null);
                      startDraw(false);
                    } else {
                      stopDraw();
                      setSketchMode("gear");
                      const ctx = getCtx();
                      if (ctx) {
                        ctx.fillStyle = BG;
                        ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
                      }
                    }
                  }}
                  className="w-full mt-2 py-2 rounded-lg text-xs font-semibold border"
                  style={{
                    borderColor: accent,
                    background: sketchMode === "gear" ? accent : "transparent",
                    color: sketchMode === "gear" ? "#0d1021" : accent,
                  }}
                >
                  {sketchMode === "gear"
                    ? "✍️ ギアの輪郭を描いて(タップで中止)"
                    : hasGear
                    ? "✍️ 手書きギアを描き直す"
                    : "✍️ ギアを手書きする"}
                </button>
              )}
            </div>

            <Slider label="固定円 R" value={R} min={80} max={300} onChange={setR} />
            <Slider label="転円 r" value={r} min={10} max={150} onChange={setr} />
            {chain && (
              <>
                <Slider label="子ギア r₂" value={r2} min={5} max={140} onChange={setR2} />
                <p className="text-[11px] text-slate-500 -mt-1 mb-3">
                  実際に使う値: <span style={{ color: accent }}>r₂ = {snapChainR2(R, r, r2, outer)}</span>
                  {" ("}
                  {chainPeriod(Math.round(R), Math.round(r), snapChainR2(R, r, r2, outer), outer)}
                  回転で閉じる{")"} — 曲線が閉じる値に自動調整されます
                </p>
              </>
            )}
            <Slider label="ペン位置 d" value={d} min={0} max={160} onChange={setd} />

            <div className="flex gap-2 mb-3">
              {[{ v: false, label: "内側" }, { v: true, label: "外側" }].map((o) => (
                <button
                  key={o.label}
                  onClick={() => setOuter(o.v)}
                  className="flex-1 py-1.5 rounded-lg text-xs font-medium"
                  style={{
                    background: outer === o.v ? accent : "#1e293b",
                    color: outer === o.v ? "#0d1021" : "#94a3b8",
                  }}
                >
                  {o.label}
                </button>
              ))}
              <button
                onClick={() => setChain(!chain)}
                className="flex-1 py-1.5 rounded-lg text-xs font-medium"
                style={{
                  background: chain ? accent : "#1e293b",
                  color: chain ? "#0d1021" : "#94a3b8",
                }}
              >
                ⚙️連結
              </button>
            </div>

          </>
        )}

        {mode === "lissajous" && (
          <>
            <Slider label="周波数 a (横)" value={la} min={1} max={12} onChange={setLa} />
            <Slider label="周波数 b (縦)" value={lb} min={1} max={12} onChange={setLb} />
            <Slider label="位相差 δ" value={phase} min={0} max={180} onChange={setPhase} unit="°" />
          </>
        )}

        {mode === "rose" && (
          <>
            <Slider label="花びら n" value={rn} min={1} max={12} onChange={setRn} />
            <Slider label="分母 m" value={rm} min={1} max={9} onChange={setRm} />
            <Slider label="大きさ" value={rA} min={80} max={300} onChange={setRA} />
          </>
        )}

        {mode === "fourier" && (
          <>
            {!is3D && (
              <div className="flex gap-2 mb-3">
                <button
                  onClick={() => {
                    if (sketchMode) {
                      setSketchMode(null);
                      if (hasShape) startDraw(false);
                    } else {
                      stopDraw();
                      setSketchMode("fourier");
                      const ctx = getCtx();
                      if (ctx) {
                        ctx.fillStyle = BG;
                        ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
                      }
                    }
                  }}
                  className="flex-1 py-2 rounded-lg text-xs font-semibold border"
                  style={{
                    borderColor: accent,
                    background: sketchMode ? accent : "transparent",
                    color: sketchMode ? "#0d1021" : accent,
                  }}
                >
                  {sketchMode ? "✍️ 入力モード中(タップで表示へ)" : "✍️ 新しい形を描く"}
                </button>
                {hasShape && (
                  <button
                    onClick={() => {
                      stopDraw();
                      const F = fourierRef.current;
                      F.raw = [];
                      F.coeffs = null;
                      F.trace = [];
                      setHasShape(false);
                      setSketchMode("fourier");
                      const ctx = getCtx();
                      if (ctx) {
                        ctx.fillStyle = BG;
                        ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
                      }
                    }}
                    className="px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-400 active:bg-slate-700"
                  >
                    形を破棄
                  </button>
                )}
              </div>
            )}
            <Slider label="円の数" value={numCircles} min={2} max={100} onChange={setNumCircles} />
            <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">
              「新しい形を描く」でキャンバスが入力モードになり、指で一筆書きできます。クリアしても手書きした形は残るので、円の数やペンを変えて何度でも描き直せます。形そのものを捨てるときは「形を破棄」。
            </p>
          </>
        )}

        {is3D && (
          <>
            <Slider label="Z波の高さ" value={zAmp} min={0} max={250} onChange={setZAmp} />
            <div className="mb-3">
              <div className="flex justify-between items-baseline mb-1">
                <span className="text-[11px] tracking-widest text-slate-400 uppercase">
                  Z波 : 花びら
                </span>
                <span className="font-mono text-[11px]" style={{ color: accent }}>
                  {zRatio === 1
                    ? "花びら1枚に1山"
                    : zRatio < 1
                    ? "花びら" + Math.round(1 / zRatio) + "枚に1山"
                    : "花びら1枚に" + zRatio + "山"}
                </span>
              </div>
              <div className="flex gap-1.5">
                {Z_RATIOS.map((zr) => (
                  <button
                    key={zr.v}
                    onClick={() => setZRatio(zr.v)}
                    className="flex-1 py-1.5 rounded-lg text-xs font-mono font-semibold"
                    style={{
                      background: zRatio === zr.v ? accent : "#1e293b",
                      color: zRatio === zr.v ? "#0d1021" : "#94a3b8",
                    }}
                  >
                    {zr.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={() => setMirror3d(!mirror3d)}
              className="w-full py-1.5 rounded-lg text-xs font-medium mb-3"
              style={{
                background: mirror3d ? accent : "#1e293b",
                color: mirror3d ? "#0d1021" : "#94a3b8",
              }}
            >
              🧊 3軸対称(XY / XZ / YZ 平面)
            </button>
          </>
        )}

        {(mode !== "fourier" || is3D) && (
        <div className="mb-3">
          <span className="text-[11px] tracking-widest text-slate-400 uppercase">対称</span>
          <div className="flex gap-1.5 mt-1">
            {SYMMETRIES.map((n) => (
              <button
                key={n}
                onClick={() => setSym(n)}
                className="flex-1 py-1.5 rounded-lg text-xs font-mono font-semibold"
                style={{
                  background: sym === n ? accent : "#1e293b",
                  color: sym === n ? "#0d1021" : "#94a3b8",
                }}
              >
                {n === 1 ? "OFF" : "×" + n}
              </button>
            ))}
          </div>
        </div>
        )}

        {!is3D && <Slider label="線の太さ" value={width} min={0.5} max={5} step={0.1} onChange={setWidth} />}
        <Slider label="速度" value={speed} min={1} max={12} onChange={setSpeed} />
        </>)}

        <p className="text-[11px] text-slate-600 mt-3 leading-relaxed">
          「描く」は毎回まっさらから描き直します。重ね描きしたいときは🎨をONに。おすすめは 3D + リサージュ + 対称×6 + ⚡速度ペン。
        </p>
      </div>
    </div>
  );
}
