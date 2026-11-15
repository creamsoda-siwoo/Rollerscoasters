import { Vector3 } from 'three';
import type { Track } from '../track/spline';
import type { ControlPoint } from '../track/types';
import { DEFAULT_PHYSICS, simulateRide } from './simulation';
import type { PhysicsParams } from './simulation';

/** 자동 뱅킹이 만들어 내는 최대 기울기(도) */
const MAX_AUTO_BANK = 75;

/**
 * 자동 뱅킹: 예상 통과 속도에서 탑승자가 받는 힘이 좌석 바닥 쪽으로 향하도록
 * 각 제어점의 뱅킹을 계산한다(횡 G 최소화).
 *
 * 체인 리프트, 승강장, 뒤집힌 구간(루프·코르크스크류)은 건드리지 않는다.
 * 반환값은 제어점 순서의 뱅킹(도) 배열.
 */
export function computeAutoBank(
  points: readonly ControlPoint[],
  track: Track,
  params: PhysicsParams = DEFAULT_PHYSICS,
): number[] {
  const { speed } = simulateRide(track, params, true);
  const up = new Vector3();
  const right = new Vector3();
  const win = Math.max(1, Math.round(2 / track.step));
  let lastSpeed = params.chainSpeed;

  return points.map((p, i) => {
    const k = track.indexAt(track.pointS[i]);
    let v = speed ? speed[k] : 0;
    if (v > 0.5) lastSpeed = v;
    else v = lastSpeed; // 열차가 도달하지 못한 구간은 직전 속도로 추정

    if (i === 0 || p.chain || points[(i + points.length - 1) % points.length].chain) return 0;
    if (Math.abs(p.bank) > 80) return p.bank;

    track.baseAxes(k, up, right);
    if (up.y < 0.05) return p.bank;

    // 제어점 주변 ±2m 의 평균 곡률
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let w = -win; w <= win; w++) {
      const o = ((k + w + track.count) % track.count) * 3;
      cx += track.curv[o];
      cy += track.curv[o + 1];
      cz += track.curv[o + 2];
    }
    const n = win * 2 + 1;
    const v2 = v * v;
    const fx = (v2 * cx) / n;
    const fy = (v2 * cy) / n + params.gravity;
    const fz = (v2 * cz) / n;
    const lat = fx * right.x + fy * right.y + fz * right.z;
    const vert = fx * up.x + fy * up.y + fz * up.z;
    if (vert < 1) return p.bank; // 에어타임 구간: 기준이 불안정하므로 유지

    const deg = (Math.atan2(lat, vert) * 180) / Math.PI;
    const clamped = Math.max(-MAX_AUTO_BANK, Math.min(MAX_AUTO_BANK, deg * 0.92));
    return Math.abs(clamped) < 2 ? 0 : Math.round(clamped);
  });
}
