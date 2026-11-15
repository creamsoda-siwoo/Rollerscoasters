import { makePoint } from './course';
import { wrapDeg } from './spline';
import type { ControlPoint } from './types';

/**
 * 프리셋 부품. 선택한 제어점을 진입점으로 삼아 그 뒤에 끼워 넣을 제어점 목록을 만든다.
 * 로컬 좌표: f = 진행 방향(수평), u = 위, r = 오른쪽.
 */

export type PresetKind = 'loop' | 'corkscrew' | 'drop';

export const PRESET_LABEL: Record<PresetKind, string> = {
  loop: '루프',
  corkscrew: '코르크스크류',
  drop: '급하강',
};

export interface PresetContext {
  /** 진입점(선택한 제어점) 위치 */
  origin: { x: number; y: number; z: number };
  /** 진입 방향의 수평 성분(단위 벡터) */
  heading: { x: number; z: number };
  /** 지면 높이 */
  groundAt: (x: number, z: number) => number;
  /** 배치 가능한 범위(±m) */
  bounds: number;
}

export type PresetResult = { ok: true; points: ControlPoint[] } | { ok: false; error: string };

interface Local {
  f: number;
  u: number;
  r: number;
  bank: number;
}

/** 지면 위 최소 여유(m) */
const CLEARANCE = 1.8;

function place(ctx: PresetContext, locals: Local[], liftToClear: boolean): PresetResult {
  const { origin, heading } = ctx;
  // 오른쪽 = heading × up
  const rx = -heading.z;
  const rz = heading.x;
  let lift = 0;
  const world = locals.map((l) => {
    const x = origin.x + heading.x * l.f + rx * l.r;
    const z = origin.z + heading.z * l.f + rz * l.r;
    const y = origin.y + l.u;
    lift = Math.max(lift, ctx.groundAt(x, z) + CLEARANCE - y);
    return { x, y, z, bank: l.bank };
  });
  if (!liftToClear) lift = 0;
  for (const w of world) {
    if (Math.abs(w.x) > ctx.bounds || Math.abs(w.z) > ctx.bounds) {
      return { ok: false, error: '이 방향으로는 공간이 부족합니다. 진입점을 안쪽으로 옮겨 보세요.' };
    }
  }
  return { ok: true, points: world.map((w) => makePoint(w.x, w.y + lift, w.z, w.bank, false)) };
}

/**
 * 수직 루프. 바닥은 완만하고 꼭대기는 급한 물방울(클로소이드풍) 모양이라
 * 진입 G 가 과하지 않다. 진입·진출 레일이 겹치지 않게 오른쪽으로 조금씩 비켜 간다.
 */
function loop(ctx: PresetContext): PresetResult {
  const R_BOTTOM = 20;
  const R_TOP = 5.4;
  const POWER = 1.8;
  const SHIFT = 3.4;
  const POINTS = 12;
  const SUB = 60;

  const locals: Local[] = [];
  let f = 0;
  let u = 0;
  const dTheta = (Math.PI * 2) / (POINTS * SUB);
  for (let i = 1; i <= POINTS * SUB; i++) {
    // 중점 적분
    const th = (i - 0.5) * dTheta;
    const radius = R_TOP + (R_BOTTOM - R_TOP) * Math.pow((1 + Math.cos(th)) / 2, POWER);
    f += radius * Math.cos(th) * dTheta;
    u += radius * Math.sin(th) * dTheta;
    if (i % SUB === 0) {
      const theta = i * dTheta;
      // 수직 구간에서는 옆으로 밀지 않아야 프레임이 비틀리지 않는다
      const r = (SHIFT * (theta + 0.5 * Math.sin(2 * theta))) / (Math.PI * 2);
      locals.push({ f, u: i === POINTS * SUB ? 0 : u, r, bank: 0 });
    }
  }
  return place(ctx, locals, true);
}

/**
 * 코르크스크류: 수평 축을 중심으로 한 바퀴 도는 길쭉한 나선.
 * 진입 방향이 나선의 접선과 일치하도록 축을 왼쪽으로 돌려 놓는다.
 * 뱅킹은 설계 속도로 지날 때 원심력+중력의 합이 좌석 바닥을 향하도록 잡아
 * 뒤집히는 동안에도 옆으로 쏠리지 않게 한다.
 */
function corkscrew(ctx: PresetContext): PresetResult {
  const RADIUS = 4.2;
  const PITCH = 40;
  const POINTS = 8;
  const DESIGN_SPEED = 20;
  const GRAVITY = 9.81;

  const c = PITCH / (Math.PI * 2);
  const alpha = Math.atan2(RADIUS, c);
  const kappa = RADIUS / (RADIUS * RADIUS + c * c);
  // 로컬 (f, u, r) 성분. 로컬 축은 월드 (x, y, z) 와 같은 방향성이라 외적 공식을 그대로 쓴다.
  const A = [Math.cos(alpha), 0, -Math.sin(alpha)];
  const S = [Math.sin(alpha), 0, Math.cos(alpha)];

  const locals: Local[] = [];
  for (let j = 1; j <= POINTS; j++) {
    const t = (j / POINTS) * Math.PI * 2;
    const along = c * t;
    const side = RADIUS * Math.sin(t);
    const f = A[0] * along + S[0] * side;
    const r = A[2] * along + S[2] * side;
    const u = RADIUS * (1 - Math.cos(t));

    // 접선
    let tf = A[0] * c + S[0] * RADIUS * Math.cos(t);
    let tu = RADIUS * Math.sin(t);
    let tr = A[2] * c + S[2] * RADIUS * Math.cos(t);
    const tl = Math.hypot(tf, tu, tr);
    tf /= tl;
    tu /= tl;
    tr /= tl;

    // 탑승자가 받는 힘의 방향 = 원심 가속(나선 축 방향) + 중력 반대 방향
    const centripetal = Math.max(0, DESIGN_SPEED * DESIGN_SPEED - 2 * GRAVITY * u) * kappa;
    let wf = centripetal * -Math.sin(t) * S[0];
    let wu = centripetal * Math.cos(t) + GRAVITY;
    let wr = centripetal * -Math.sin(t) * S[2];
    const wt = wf * tf + wu * tu + wr * tr;
    wf -= wt * tf;
    wu -= wt * tu;
    wr -= wt * tr;

    // 기준 프레임: 오른쪽은 수평(= T × up), 위 = 오른쪽 × T
    const hl = Math.hypot(tf, tr);
    const Rf = -tr / hl;
    const Rr = tf / hl;
    const Uf = -Rr * tu;
    const Uu = Rr * tf - Rf * tr;
    const Ur = Rf * tu;
    const bank = (Math.atan2(wf * Rf + wr * Rr, wf * Uf + wu * Uu + wr * Ur) * 180) / Math.PI;
    locals.push({ f, u, r, bank: j === POINTS ? 0 : Math.round(wrapDeg(bank)) });
  }
  return place(ctx, locals, true);
}

/** 급하강: 정상에서 둥글게 넘어가 최대 80° 로 떨어진 뒤 지면 가까이에서 크게 빠져나온다 */
function drop(ctx: PresetContext): PresetResult {
  const { origin, heading } = ctx;
  // 낙하 구간 아래 지면 중 가장 높은 곳을 바닥 기준으로 삼는다
  let ground = -Infinity;
  for (let d = 0; d <= 70; d += 5) {
    ground = Math.max(ground, ctx.groundAt(origin.x + heading.x * d, origin.z + heading.z * d));
  }
  const height = origin.y - (ground + CLEARANCE + 0.4);
  if (height < 8) {
    return { ok: false, error: '급하강을 넣으려면 진입점이 지면에서 10m 이상 높아야 합니다.' };
  }
  const rc = Math.min(10, Math.max(5, height * 0.28));
  const rp = Math.min(26, Math.max(11, height * 0.6));
  let theta = (80 * Math.PI) / 180;
  let straight = 0;
  const need = (rc + rp) * (1 - Math.cos(theta));
  if (need > height) {
    theta = Math.acos(1 - height / (rc + rp));
  } else {
    straight = (height - need) / Math.sin(theta);
  }

  const locals: Local[] = [];
  const add = (f: number, u: number) => locals.push({ f, u, r: 0, bank: 0 });
  // 정상 곡선
  add(rc * Math.sin(theta / 2), -rc * (1 - Math.cos(theta / 2)));
  let f = rc * Math.sin(theta);
  let u = -rc * (1 - Math.cos(theta));
  add(f, u);
  // 직선 낙하
  if (straight > 3) {
    f += straight * Math.cos(theta);
    u -= straight * Math.sin(theta);
    add(f, u);
  } else {
    f += straight * Math.cos(theta);
    u -= straight * Math.sin(theta);
  }
  // 빠져나오는 곡선
  const half = theta / 2;
  add(f + rp * (Math.sin(theta) - Math.sin(half)), u - rp * (Math.cos(half) - Math.cos(theta)));
  f += rp * Math.sin(theta);
  u -= rp * (1 - Math.cos(theta));
  add(f, u);
  add(f + 12, u);
  return place(ctx, locals, false);
}

export function buildPreset(kind: PresetKind, ctx: PresetContext): PresetResult {
  switch (kind) {
    case 'loop':
      return loop(ctx);
    case 'corkscrew':
      return corkscrew(ctx);
    case 'drop':
      return drop(ctx);
  }
}
