import { describe, expect, it } from 'vitest';
import { computeAutoBank } from '../src/physics/autobank';
import { computeThrill } from '../src/physics/scoring';
import { DEFAULT_PHYSICS, RideSim, simulateRide } from '../src/physics/simulation';
import type { PhysicsParams } from '../src/physics/simulation';
import { createDefaultCourse, createStarterCourse, makePoint } from '../src/track/course';
import { buildTrack } from '../src/track/spline';

const frictionless: PhysicsParams = { ...DEFAULT_PHYSICS, rollingFriction: 0, airDrag: 0 };

/** 높은 곳에서 출발해 골짜기를 지나 다시 오르는 순환 트랙 */
function valley(startHeight: number, hillHeight: number) {
  return buildTrack([
    makePoint(-90, startHeight, 0),
    makePoint(-60, startHeight - 1, 0),
    makePoint(-20, 4, 0),
    makePoint(20, 4, 0),
    makePoint(60, hillHeight, 0),
    makePoint(100, 4, 20),
    makePoint(60, 6, 80),
    makePoint(-60, 12, 80),
    makePoint(-110, startHeight - 2, 40),
  ]);
}

describe('에너지 보존 물리', () => {
  it('마찰이 없으면 역학적 에너지가 보존된다', () => {
    const track = valley(40, 20);
    const sim = new RideSim(track, frictionless);
    const g = frictionless.gravity;
    let e0: number | null = null;
    let worst = 0;
    while (sim.status === 'running' && sim.s < track.length * 0.6) {
      sim.step();
      if (sim.driven || sim.s < frictionless.stationLength + 1) continue;
      const e = 0.5 * sim.v * sim.v + g * track.heightAt(sim.s);
      if (e0 === null) e0 = e;
      worst = Math.max(worst, Math.abs(e - e0));
    }
    expect(e0).not.toBeNull();
    // 총 에너지(약 400 J/kg) 대비 오차 0.1% 미만
    expect(worst).toBeLessThan(0.4);
  });

  it('내려가면 빨라지고 올라가면 느려진다 (v² = v₀² + 2gΔh)', () => {
    const track = valley(40, 20);
    const sim = new RideSim(track, frictionless);
    const g = frictionless.gravity;
    // 승강장 구동이 끝난 직후를 기준점으로 삼는다
    while (sim.s < frictionless.stationLength + 1) sim.step();
    const v0 = sim.v;
    const y0 = track.heightAt(sim.s);
    let lowest = { y: Infinity, v: 0 };
    let hill = { y: -Infinity, v: 0 };
    while (sim.status === 'running' && sim.s < track.pointS[5]) {
      sim.step();
      const y = track.heightAt(sim.s);
      if (y < lowest.y) lowest = { y, v: sim.v };
      if (sim.s > track.pointS[3] && y > hill.y) hill = { y, v: sim.v };
    }
    expect(lowest.v).toBeCloseTo(Math.sqrt(v0 * v0 + 2 * g * (y0 - lowest.y)), 2);
    expect(hill.v).toBeCloseTo(Math.sqrt(v0 * v0 + 2 * g * (y0 - hill.y)), 2);
    expect(lowest.v).toBeGreaterThan(25);
    expect(hill.v).toBeLessThan(lowest.v - 5);
  });

  it('마찰과 공기저항은 속도를 조금 깎는다', () => {
    const track = valley(40, 20);
    const free = simulateRide(track, frictionless).record;
    const real = simulateRide(track).record;
    expect(real.maxSpeed).toBeLessThan(free.maxSpeed);
    expect(real.maxSpeed).toBeGreaterThan(free.maxSpeed * 0.9);
  });

  it('언덕이 출발 높이보다 높으면 넘지 못하고 그 앞에서 멈춘다', () => {
    const track = valley(20, 45);
    const res = simulateRide(track);
    expect(res.record.completed).toBe(false);
    expect(res.stallAt).not.toBeNull();
    // 멈춘 곳은 언덕 꼭대기(제어점 4) 앞의 오르막
    expect(res.stallAt!).toBeGreaterThan(track.pointS[3]);
    expect(res.stallAt!).toBeLessThan(track.pointS[4]);
    expect(track.heightAt(res.stallAt!)).toBeLessThan(21.5);
    expect(res.record.thrill).toBe(0);
  });

  it('체인 리프트는 열차를 끌어올린다', () => {
    const pts = createStarterCourse().points;
    const withChain = simulateRide(buildTrack(pts)).record;
    expect(withChain.completed).toBe(true);
    const noChain = simulateRide(buildTrack(pts.map((p) => ({ ...p, chain: false })))).record;
    expect(noChain.completed).toBe(false);
  });

  it('같은 트랙은 항상 같은 결과를 낸다', () => {
    const track = buildTrack(createDefaultCourse().points);
    const a = simulateRide(track).record;
    const b = simulateRide(track).record;
    expect({ ...a, recordedAt: '' }).toEqual({ ...b, recordedAt: '' });
    // 실시간처럼 들쭉날쭉한 프레임 간격으로 돌려도 같다
    const sim = new RideSim(track);
    let i = 0;
    while (sim.status === 'running') sim.advance(0.004 + (i++ % 7) * 0.003);
    expect(sim.record().rideTime).toBeCloseTo(a.rideTime, 6);
    expect(sim.record().maxSpeed).toBeCloseTo(a.maxSpeed, 6);
  });

  it('정지 상태에서 1G, 골짜기에서 1G 초과, 언덕 위에서 1G 미만', () => {
    const track = valley(40, 14);
    const sim = new RideSim(track);
    expect(sim.gVert).toBeCloseTo(1, 5);
    let gValley = 0;
    let gCrest = 9;
    while (sim.status === 'running' && sim.s < track.length * 0.5) {
      sim.step();
      if (sim.s > track.pointS[2] - 15 && sim.s < track.pointS[2] + 5) gValley = Math.max(gValley, sim.gVert);
      if (Math.abs(sim.s - track.pointS[4]) < 5) gCrest = Math.min(gCrest, sim.gVert);
    }
    expect(gValley).toBeGreaterThan(1.5);
    expect(gCrest).toBeLessThan(0.8);
  });
});

describe('기본 코스', () => {
  it('시연 코스는 과도한 G 없이 완주한다', () => {
    const r = simulateRide(buildTrack(createDefaultCourse().points)).record;
    expect(r.completed).toBe(true);
    expect(r.inversions).toBe(2);
    expect(r.maxG).toBeLessThan(5.2);
    expect(r.minG).toBeGreaterThan(-1.5);
    expect(r.maxLateralG).toBeLessThan(1.6);
    expect(r.overGTime).toBe(0);
    expect(r.thrill).toBeGreaterThan(400);
  });

  it('새 코스(스타터)도 완주한다', () => {
    const r = simulateRide(buildTrack(createStarterCourse().points)).record;
    expect(r.completed).toBe(true);
    expect(r.overGTime).toBe(0);
  });
});

describe('자동 뱅킹', () => {
  it('횡 G 를 줄이고 회전 방향으로 기울인다', () => {
    const pts = createStarterCourse().points.map((p) => ({ ...p, bank: 0 }));
    const before = simulateRide(buildTrack(pts)).record.maxLateralG;
    const banks = computeAutoBank(pts, buildTrack(pts));
    pts.forEach((p, i) => (p.bank = banks[i]));
    const after = simulateRide(buildTrack(pts)).record.maxLateralG;
    expect(after).toBeLessThan(before * 0.75);
    // 이 코스는 거의 계속 왼쪽으로 도므로 뱅킹도 대부분 왼쪽(음수)
    expect(Math.min(...banks)).toBeLessThan(-20);
    expect(Math.max(...banks)).toBeLessThan(20);
    // 체인 구간과 출발점은 건드리지 않는다
    expect(banks[0]).toBe(0);
    pts.forEach((p, i) => p.chain && expect(banks[i]).toBe(0));
  });
});

describe('스릴 점수', () => {
  const base = {
    completed: true, rideTime: 60, maxSpeed: 25, avgSpeed: 12, maxG: 4, minG: -0.5, maxLateralG: 1,
    airtime: 2, inversions: 1, maxDrop: 30, maxHeight: 35, trackLength: 600, overGTime: 0, stallAt: null,
  };
  it('완주하지 못하면 0점', () => {
    expect(computeThrill({ ...base, completed: false })).toBe(0);
  });
  it('더 빠르고 더 많이 뒤집힐수록 높다', () => {
    expect(computeThrill({ ...base, maxSpeed: 32 })).toBeGreaterThan(computeThrill(base));
    expect(computeThrill({ ...base, inversions: 3 })).toBeGreaterThan(computeThrill(base));
  });
  it('과도한 G 는 감점', () => {
    expect(computeThrill({ ...base, overGTime: 2 })).toBeLessThan(computeThrill(base));
  });
});
