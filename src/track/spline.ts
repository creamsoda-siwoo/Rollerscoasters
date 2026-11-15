import { Vector3 } from 'three';
import type { ControlPoint } from './types';

/**
 * 제어점 → 주행 가능한 트랙.
 *
 * 1. 닫힌 centripetal Catmull-Rom 스플라인으로 중심선을 만들고
 * 2. 호 길이(arc length) 기준 등간격으로 다시 샘플링한 뒤
 * 3. 각 샘플에 진행/위/오른쪽 축(프레임), 곡률, 뱅킹을 계산해 둔다.
 *
 * 물리·메쉬·카메라는 모두 이 등간격 테이블만 조회한다.
 */

/** 샘플 간격 목표값(m) */
export const SAMPLE_STEP = 0.5;

const DEG = Math.PI / 180;

export interface TrackFrame {
  pos: Vector3;
  /** 진행 방향(단위) */
  tan: Vector3;
  /** 탑승자 머리 방향(단위, 뱅킹 반영) */
  up: Vector3;
  /** 탑승자 오른쪽(단위) = tan × up */
  right: Vector3;
  /** 곡률 벡터 dT/ds (1/m) */
  curv: Vector3;
  chain: boolean;
  /** 이 위치가 속한 제어 구간(제어점 seg → seg+1) */
  seg: number;
  /** 보간된 뱅킹(도) */
  bank: number;
}

export function createFrame(): TrackFrame {
  return {
    pos: new Vector3(),
    tan: new Vector3(0, 0, -1),
    up: new Vector3(0, 1, 0),
    right: new Vector3(1, 0, 0),
    curv: new Vector3(),
    chain: false,
    seg: 0,
    bank: 0,
  };
}

/** 각도 차를 [-180, 180) 로 접는다 */
export function wrapDeg(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function distSq(a: ControlPoint, b: ControlPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export class Track {
  constructor(
    /** 한 바퀴 길이(m) */
    readonly length: number,
    /** 샘플 수. 샘플 k 는 s = k * step 위치. 닫힌 루프라 샘플 count 는 샘플 0 과 같다. */
    readonly count: number,
    /** 실제 샘플 간격(m) */
    readonly step: number,
    readonly pos: Float64Array,
    readonly tan: Float64Array,
    readonly up: Float64Array,
    readonly right: Float64Array,
    readonly curv: Float64Array,
    /** 기준 프레임에 적용된 롤(라디안) = 뱅킹 + 폐합 보정 */
    readonly roll: Float32Array,
    /** 보간된 뱅킹(도) */
    readonly bank: Float32Array,
    readonly seg: Uint16Array,
    readonly chain: Uint8Array,
    /** 각 제어점의 호 길이 위치(m) */
    readonly pointS: Float64Array,
  ) {}

  /** s 를 [0, length) 로 접는다 */
  wrap(s: number): number {
    const L = this.length;
    s %= L;
    return s < 0 ? s + L : s;
  }

  indexAt(s: number): number {
    return Math.min(this.count - 1, Math.floor(this.wrap(s) / this.step));
  }

  heightAt(s: number): number {
    const f = this.wrap(s) / this.step;
    let i = Math.floor(f);
    if (i >= this.count) i = this.count - 1;
    const t = f - i;
    const j = i + 1 === this.count ? 0 : i + 1;
    const a = this.pos[i * 3 + 1];
    return a + (this.pos[j * 3 + 1] - a) * t;
  }

  positionAt(s: number, out: Vector3): Vector3 {
    const f = this.wrap(s) / this.step;
    let i = Math.floor(f);
    if (i >= this.count) i = this.count - 1;
    const t = f - i;
    const j = i + 1 === this.count ? 0 : i + 1;
    const p = this.pos;
    const a = i * 3;
    const b = j * 3;
    return out.set(p[a] + (p[b] - p[a]) * t, p[a + 1] + (p[b + 1] - p[a + 1]) * t, p[a + 2] + (p[b + 2] - p[a + 2]) * t);
  }

  /** s 위치의 프레임을 선형 보간으로 구한다 */
  frameAt(s: number, out: TrackFrame): TrackFrame {
    const f = this.wrap(s) / this.step;
    let i = Math.floor(f);
    if (i >= this.count) i = this.count - 1;
    const t = f - i;
    const j = i + 1 === this.count ? 0 : i + 1;
    const a = i * 3;
    const b = j * 3;
    lerp3(this.pos, a, b, t, out.pos);
    lerp3(this.tan, a, b, t, out.tan).normalize();
    lerp3(this.curv, a, b, t, out.curv);
    lerp3(this.up, a, b, t, out.up);
    // 보간 뒤에도 직교가 유지되도록 다시 맞춘다
    out.up.addScaledVector(out.tan, -out.up.dot(out.tan)).normalize();
    out.right.crossVectors(out.tan, out.up);
    out.chain = this.chain[i] === 1;
    out.seg = this.seg[i];
    out.bank = this.bank[i];
    return out;
  }

  isChain(s: number): boolean {
    return this.chain[this.indexAt(s)] === 1;
  }

  /** 뱅킹을 적용하기 전(기준) 프레임의 위/오른쪽 축 */
  baseAxes(index: number, outUp: Vector3, outRight: Vector3): void {
    const o = index * 3;
    const c = Math.cos(this.roll[index]);
    const sn = Math.sin(this.roll[index]);
    const ux = this.up[o], uy = this.up[o + 1], uz = this.up[o + 2];
    const rx = this.right[o], ry = this.right[o + 1], rz = this.right[o + 2];
    // 적용: R' = R c − U s, U' = U c + R s  →  역변환
    outRight.set(rx * c + ux * sn, ry * c + uy * sn, rz * c + uz * sn);
    outUp.set(ux * c - rx * sn, uy * c - ry * sn, uz * c - rz * sn);
  }
}

function lerp3(arr: Float64Array, a: number, b: number, t: number, out: Vector3): Vector3 {
  return out.set(
    arr[a] + (arr[b] - arr[a]) * t,
    arr[a + 1] + (arr[b + 1] - arr[a + 1]) * t,
    arr[a + 2] + (arr[b + 2] - arr[a + 2]) * t,
  );
}

/** 제어 구간 i 의 뱅킹(도)을 u∈[0,1] 에서 보간. 이웃 값은 최단 경로로 펼쳐서 쓴다. */
function bankAt(points: readonly ControlPoint[], i: number, u: number): number {
  const n = points.length;
  const bm = points[(i + n - 1) % n].bank;
  const b1 = points[i].bank;
  const bn = points[(i + 1) % n].bank;
  const bnn = points[(i + 2) % n].bank;
  const d0 = wrapDeg(b1 - bm);
  const d1 = wrapDeg(bn - b1);
  const d2 = wrapDeg(bnn - bn);
  const b2 = b1 + d1;
  // 기울기 부호가 바뀌는 곳(극값)에서는 접선을 0 으로 눌러 오버슈트를 막는다
  const m1 = d0 * d1 <= 0 ? 0 : (d0 + d1) / 2;
  const m2 = d1 * d2 <= 0 ? 0 : (d1 + d2) / 2;
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * b1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * b2 + (u3 - u2) * m2;
}

export function buildTrack(points: readonly ControlPoint[], targetStep = SAMPLE_STEP): Track {
  const n = points.length;
  if (n < 3) throw new Error('제어점이 3개 이상 필요합니다');

  // ── 1) 구간별 3차 다항식 계수 (centripetal Catmull-Rom, 닫힌 루프) ──────────
  const coef = new Float64Array(n * 12);
  for (let i = 0; i < n; i++) {
    const p0 = points[(i + n - 1) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    let dt0 = Math.pow(distSq(p0, p1), 0.25);
    let dt1 = Math.pow(distSq(p1, p2), 0.25);
    let dt2 = Math.pow(distSq(p2, p3), 0.25);
    if (dt1 < 1e-4) dt1 = 1;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;
    for (let a = 0; a < 3; a++) {
      const x0 = a === 0 ? p0.x : a === 1 ? p0.y : p0.z;
      const x1 = a === 0 ? p1.x : a === 1 ? p1.y : p1.z;
      const x2 = a === 0 ? p2.x : a === 1 ? p2.y : p2.z;
      const x3 = a === 0 ? p3.x : a === 1 ? p3.y : p3.z;
      let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
      let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
      t1 *= dt1;
      t2 *= dt1;
      const o = i * 12 + a * 4;
      coef[o] = x1;
      coef[o + 1] = t1;
      coef[o + 2] = -3 * x1 + 3 * x2 - 2 * t1 - t2;
      coef[o + 3] = 2 * x1 - 2 * x2 + t1 + t2;
    }
  }
  const evalAxis = (i: number, a: number, u: number): number => {
    const o = i * 12 + a * 4;
    return coef[o] + u * (coef[o + 1] + u * (coef[o + 2] + u * coef[o + 3]));
  };
  const evalDeriv = (i: number, a: number, u: number): number => {
    const o = i * 12 + a * 4;
    return coef[o + 1] + u * (2 * coef[o + 2] + u * 3 * coef[o + 3]);
  };

  // ── 2) 촘촘히 샘플링해 누적 호 길이 표를 만든다 ────────────────────────────
  const denseG: number[] = [0];
  const denseLen: number[] = [0];
  const pointS = new Float64Array(n);
  let total = 0;
  let px = points[0].x;
  let py = points[0].y;
  let pz = points[0].z;
  for (let i = 0; i < n; i++) {
    pointS[i] = total;
    const chord = Math.sqrt(distSq(points[i], points[(i + 1) % n]));
    const K = Math.max(8, Math.min(600, Math.ceil(chord / (targetStep * 0.4))));
    for (let j = 1; j <= K; j++) {
      const u = j / K;
      const x = evalAxis(i, 0, u);
      const y = evalAxis(i, 1, u);
      const z = evalAxis(i, 2, u);
      total += Math.hypot(x - px, y - py, z - pz);
      px = x;
      py = y;
      pz = z;
      denseG.push(i + u);
      denseLen.push(total);
    }
  }
  if (total < 1e-3) total = 1e-3; // 모든 점이 겹친 퇴화 케이스 방어

  // ── 3) 호 길이 등간격 재샘플링 ─────────────────────────────────────────────
  const count = Math.max(16, Math.min(12000, Math.round(total / targetStep)));
  const step = total / count;
  const pos = new Float64Array(count * 3);
  const tan = new Float64Array(count * 3);
  const up = new Float64Array(count * 3);
  const right = new Float64Array(count * 3);
  const curv = new Float64Array(count * 3);
  const roll = new Float32Array(count);
  const bank = new Float32Array(count);
  const seg = new Uint16Array(count);
  const chain = new Uint8Array(count);

  let di = 0;
  let ltx = 1;
  let lty = 0;
  let ltz = 0;
  for (let k = 0; k < count; k++) {
    const s = k * step;
    while (di < denseLen.length - 2 && denseLen[di + 1] < s) di++;
    const l0 = denseLen[di];
    const l1 = denseLen[di + 1];
    const f = l1 > l0 ? Math.min(1, Math.max(0, (s - l0) / (l1 - l0))) : 0;
    const g = denseG[di] + (denseG[di + 1] - denseG[di]) * f;
    let i = Math.floor(g);
    let u = g - i;
    if (i >= n) {
      i = n - 1;
      u = 1;
    }
    const o = k * 3;
    pos[o] = evalAxis(i, 0, u);
    pos[o + 1] = evalAxis(i, 1, u);
    pos[o + 2] = evalAxis(i, 2, u);
    let tx = evalDeriv(i, 0, u);
    let ty = evalDeriv(i, 1, u);
    let tz = evalDeriv(i, 2, u);
    const tl = Math.hypot(tx, ty, tz);
    if (tl > 1e-9) {
      tx /= tl;
      ty /= tl;
      tz /= tl;
    } else {
      tx = ltx;
      ty = lty;
      tz = ltz;
    }
    tan[o] = ltx = tx;
    tan[o + 1] = lty = ty;
    tan[o + 2] = ltz = tz;
    seg[k] = i;
    chain[k] = points[i].chain ? 1 : 0;
    bank[k] = bankAt(points, i, u);
  }

  // ── 4) 곡률 벡터 dT/ds (중앙 차분 후 짧게 평활화) ──────────────────────────
  // Catmull-Rom 은 제어점에서 곡률이 불연속이라, 약 ±1m 창으로 다듬어 G 가 튀지 않게 한다.
  const raw = new Float64Array(count * 3);
  for (let k = 0; k < count; k++) {
    const a = ((k + 1) % count) * 3;
    const b = ((k + count - 1) % count) * 3;
    const o = k * 3;
    raw[o] = (tan[a] - tan[b]) / (2 * step);
    raw[o + 1] = (tan[a + 1] - tan[b + 1]) / (2 * step);
    raw[o + 2] = (tan[a + 2] - tan[b + 2]) / (2 * step);
  }
  const W = [1, 2, 3, 2, 1];
  for (let k = 0; k < count; k++) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let w = -2; w <= 2; w++) {
      const o = ((k + w + count) % count) * 3;
      const wt = W[w + 2];
      x += raw[o] * wt;
      y += raw[o + 1] * wt;
      z += raw[o + 2] * wt;
    }
    const o = k * 3;
    curv[o] = x / 9;
    curv[o + 1] = y / 9;
    curv[o + 2] = z / 9;
  }

  // ── 5) 기준 프레임 (뱅킹 0 일 때의 자세) ───────────────────────────────────
  // "오른쪽 축은 수평" 을 기본으로 하되, 부호는 직전 샘플과 이어지도록 고른다.
  // 그러면 완만한 구간은 항상 똑바로 서고, 수직 루프에서는 자연스럽게 뒤집힌다.
  // 접선이 수직에 가까워 수평 기준이 불안정한 곳은 직전 프레임을 평행 이동해 넘긴다.
  let rx: number;
  let ry: number;
  let rz: number;
  {
    const hx = -tan[2];
    const hz = tan[0];
    const hl = Math.hypot(hx, hz);
    if (hl > 1e-3) {
      rx = hx / hl;
      ry = 0;
      rz = hz / hl;
    } else {
      // 출발점이 수직이면 임의의 수평축에서 시작
      rx = 1;
      ry = 0;
      rz = 0;
    }
  }
  const baseR = new Float64Array(count * 3);
  for (let k = 0; k < count; k++) {
    const o = k * 3;
    const tx = tan[o];
    const ty = tan[o + 1];
    const tz = tan[o + 2];
    if (k > 0) {
      // 직전 오른쪽 축을 현재 접선에 수직이 되도록 옮긴다
      const d = rx * tx + ry * ty + rz * tz;
      let ax = rx - d * tx;
      let ay = ry - d * ty;
      let az = rz - d * tz;
      const al = Math.hypot(ax, ay, az);
      if (al > 1e-9) {
        ax /= al;
        ay /= al;
        az /= al;
      } else {
        ax = rx;
        ay = ry;
        az = rz;
      }
      const hl = Math.hypot(tx, tz);
      if (hl > 1e-6) {
        let hx = -tz / hl;
        let hz = tx / hl;
        if (hx * ax + hz * az < 0) {
          hx = -hx;
          hz = -hz;
        }
        const pull = 1 - Math.exp(-step * 3 * smoothstep(0.08, 0.55, hl));
        ax += (hx - ax) * pull;
        ay += (0 - ay) * pull;
        az += (hz - az) * pull;
        const l = Math.hypot(ax, ay, az) || 1;
        ax /= l;
        ay /= l;
        az /= l;
      }
      rx = ax;
      ry = ay;
      rz = az;
    }
    baseR[o] = rx;
    baseR[o + 1] = ry;
    baseR[o + 2] = rz;
  }

  // ── 6) 폐합 보정: 한 바퀴 돌아온 프레임이 출발 프레임과 어긋나면 끝 구간에서 풀어 준다
  //    (반 루프만 넣어 뒤집힌 채 돌아오는 설계 등)
  let closure = 0;
  {
    const tx = tan[0];
    const ty = tan[1];
    const tz = tan[2];
    const d = rx * tx + ry * ty + rz * tz;
    let ax = rx - d * tx;
    let ay = ry - d * ty;
    let az = rz - d * tz;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al;
    ay /= al;
    az /= al;
    // u' = a × T
    const ux = ay * tz - az * ty;
    const uy = az * tx - ax * tz;
    const uz = ax * ty - ay * tx;
    const c = baseR[0] * ax + baseR[1] * ay + baseR[2] * az;
    const sn = -(baseR[0] * ux + baseR[1] * uy + baseR[2] * uz);
    closure = Math.atan2(sn, c);
    if (Math.abs(closure) < 1e-3) closure = 0;
  }
  const fixLen = Math.min(40, total * 0.3);

  // ── 7) 뱅킹 적용 ───────────────────────────────────────────────────────────
  for (let k = 0; k < count; k++) {
    const o = k * 3;
    const tx = tan[o];
    const ty = tan[o + 1];
    const tz = tan[o + 2];
    const bx = baseR[o];
    const by = baseR[o + 1];
    const bz = baseR[o + 2];
    // 기준 위쪽 U = R × T
    const ux = by * tz - bz * ty;
    const uy = bz * tx - bx * tz;
    const uz = bx * ty - by * tx;
    let beta = bank[k] * DEG;
    if (closure !== 0) beta += closure * smoothstep(total - fixLen, total, k * step);
    roll[k] = beta;
    const c = Math.cos(beta);
    const sn = Math.sin(beta);
    right[o] = bx * c - ux * sn;
    right[o + 1] = by * c - uy * sn;
    right[o + 2] = bz * c - uz * sn;
    up[o] = ux * c + bx * sn;
    up[o + 1] = uy * c + by * sn;
    up[o + 2] = uz * c + bz * sn;
  }

  return new Track(total, count, step, pos, tan, up, right, curv, roll, bank, seg, chain, pointS);
}
