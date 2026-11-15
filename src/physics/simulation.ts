import { createFrame } from '../track/spline';
import type { Track, TrackFrame } from '../track/spline';
import type { RideRecord } from '../track/types';
import { AIRTIME_G, G_LIMITS, computeThrill } from './scoring';

/**
 * 트랙 위 열차의 1차원 물리.
 *
 * 상태는 "출발점부터 달린 거리 s" 와 "속력 v" 뿐이다.
 * 매 스텝 에너지 보존식으로 속력을 갱신한다:
 *
 *   v₁² = v₀² + 2g(y₀ − y₁) − 2·a_loss·Δs
 *
 * 높이 차가 그대로 속도로 바뀌고, 구름 마찰(수직 하중에 비례)과 공기 저항(v² 에 비례)만큼만
 * 에너지를 잃는다. 고정 스텝이라 같은 트랙은 언제나 같은 결과가 나온다.
 */

export interface PhysicsParams {
  /** 중력 가속도(m/s²) */
  gravity: number;
  /** 구름 마찰 계수 */
  rollingFriction: number;
  /** 공기 저항 계수(1/m): a = airDrag · v² */
  airDrag: number;
  /** 체인 리프트 속도(m/s) */
  chainSpeed: number;
  /** 체인이 열차를 끌어올리는 가속(m/s²) */
  chainAccel: number;
  /** 승강장 출발 속도(m/s) */
  stationSpeed: number;
  stationAccel: number;
  /** 승강장 구동 구간 길이(m) */
  stationLength: number;
  /** 완주 후 제동 감속(m/s²) */
  brakeDecel: number;
  /** 고정 스텝(초) */
  dt: number;
}

export const DEFAULT_PHYSICS: PhysicsParams = {
  gravity: 9.81,
  rollingFriction: 0.012,
  airDrag: 0.0005,
  chainSpeed: 6,
  chainAccel: 3,
  stationSpeed: 4,
  stationAccel: 2.5,
  stationLength: 10,
  brakeDecel: 7,
  dt: 1 / 240,
};

export type RideStatus = 'running' | 'finished' | 'stalled';

/** G 표시값 평활 시간(초). 한 스텝짜리 튐을 걸러 낸다. */
const G_SMOOTH = 0.06;
/** 이 속력 아래로 떨어지며 감속 중이면 멈춘 것으로 본다 */
const STALL_SPEED = 0.03;
/** 시뮬레이션 최대 시간(초) */
const MAX_RIDE_TIME = 900;

export class RideSim {
  /** 출발점부터 달린 거리(m). 한 바퀴를 넘으면 track.length 보다 커진다. */
  s = 0;
  /** 속력(m/s) */
  v = 0;
  /** 경과 시간(초) */
  t = 0;
  status: RideStatus = 'running';
  /** 탑승자가 느끼는 G (평활값). 정지 상태에서 vert = 1 */
  gVert = 1;
  gLat = 0;
  gLong = 0;
  /** 현재 체인/승강장 구동 중인지 */
  driven = false;

  maxSpeed = 0;
  maxG = 1;
  minG = 1;
  maxLat = 0;
  airtime = 0;
  overGTime = 0;
  inversions = 0;
  maxDrop = 0;
  maxHeight = -Infinity;
  /** 완주 시각 또는 정지 시각 */
  endTime = 0;

  private readonly f = createFrame();
  private acc = 0;
  private inverted = false;
  private hi = -Infinity;
  private lo = Infinity;

  constructor(
    readonly track: Track,
    readonly params: PhysicsParams = DEFAULT_PHYSICS,
  ) {
    const y = track.heightAt(0);
    this.hi = y;
    this.lo = y;
    this.maxHeight = y;
  }

  /** 실제 경과 시간만큼 고정 스텝을 진행한다 */
  advance(realDt: number): void {
    this.acc += realDt;
    const dt = this.params.dt;
    while (this.acc >= dt) {
      this.acc -= dt;
      this.step();
    }
  }

  /** 고정 스텝 한 번 */
  step(): void {
    const p = this.params;
    const dt = p.dt;
    const tr = this.track;
    if (this.status === 'stalled') return;

    const f = tr.frameAt(this.s, this.f);
    const g = p.gravity;
    const v0 = this.v;

    if (this.status === 'finished') {
      // 완주 후 승강장 제동
      const v1 = Math.max(0, v0 - p.brakeDecel * dt);
      this.s += (v0 + v1) * 0.5 * dt;
      this.v = v1;
      this.updateG(f, v0, v1, dt, false);
      return;
    }

    // 수직 하중: 원심 가속 + 중력 중 접선에 수직인 성분
    const v2 = v0 * v0;
    const ax = v2 * f.curv.x;
    const ay = v2 * f.curv.y + g;
    const az = v2 * f.curv.z;
    const at = ax * f.tan.x + ay * f.tan.y + az * f.tan.z;
    const normalLoad = Math.hypot(ax - at * f.tan.x, ay - at * f.tan.y, az - at * f.tan.z);
    const aLoss = p.rollingFriction * normalLoad + p.airDrag * v2;
    const a = -g * f.tan.y - aLoss;

    // 예측 → 이동 거리
    let v1 = v0 + a * dt;
    let ds = (v0 + Math.max(v1, 0)) * 0.5 * dt;
    if (ds > 0) {
      // 에너지 보존으로 속력 보정
      const y1 = tr.heightAt(this.s + ds);
      const e = v2 + 2 * g * (f.pos.y - y1) - 2 * aLoss * ds;
      v1 = e > 0 ? Math.sqrt(e) : 0;
    } else {
      v1 = 0;
    }

    // 구동 장치: 체인 리프트는 최소 속도를 보장하고 역주행을 막는다
    this.driven = false;
    if (f.chain && v1 < p.chainSpeed) {
      v1 = Math.min(p.chainSpeed, v0 + p.chainAccel * dt);
      this.driven = true;
    } else if (this.s < p.stationLength && v1 < p.stationSpeed) {
      v1 = Math.min(p.stationSpeed, v0 + p.stationAccel * dt);
      this.driven = true;
    }
    if (this.driven) ds = (v0 + v1) * 0.5 * dt;

    if (!this.driven && v1 <= STALL_SPEED && a <= 0) {
      // 오르막을 넘지 못했거나 평지에서 힘이 빠졌다
      this.v = 0;
      this.status = 'stalled';
      this.endTime = this.t;
      return;
    }

    this.s += ds;
    this.v = v1;
    this.t += dt;
    this.updateG(f, v0, v1, dt, true);

    // 통계
    if (v1 > this.maxSpeed) this.maxSpeed = v1;
    const y = f.pos.y;
    if (y > this.maxHeight) this.maxHeight = y;
    if (y > this.hi) {
      this.hi = y;
      this.lo = y;
    }
    if (y < this.lo) this.lo = y;
    if (this.hi - y > this.maxDrop) this.maxDrop = this.hi - y;
    if (y > this.lo + 3) {
      // 바닥을 찍고 다시 올라가기 시작 → 다음 낙하의 기준점을 새로 잡는다
      this.hi = y;
      this.lo = y;
    }
    if (!this.inverted && f.up.y < -0.3) {
      this.inverted = true;
      this.inversions++;
    } else if (this.inverted && f.up.y > 0.3) {
      this.inverted = false;
    }

    if (this.s >= tr.length) {
      this.status = 'finished';
      this.endTime = this.t;
    } else if (this.t > MAX_RIDE_TIME) {
      this.status = 'stalled';
      this.endTime = this.t;
    }
  }

  private updateG(f: TrackFrame, v0: number, v1: number, dt: number, track: boolean): void {
    const g = this.params.gravity;
    const vm = (v0 + v1) * 0.5;
    const aT = (v1 - v0) / dt;
    // 비력(specific force) = 가속도 − 중력가속도
    const fx = aT * f.tan.x + vm * vm * f.curv.x;
    const fy = aT * f.tan.y + vm * vm * f.curv.y + g;
    const fz = aT * f.tan.z + vm * vm * f.curv.z;
    const vert = (fx * f.up.x + fy * f.up.y + fz * f.up.z) / g;
    const lat = (fx * f.right.x + fy * f.right.y + fz * f.right.z) / g;
    const long = (fx * f.tan.x + fy * f.tan.y + fz * f.tan.z) / g;
    const k = 1 - Math.exp(-dt / G_SMOOTH);
    this.gVert += (vert - this.gVert) * k;
    this.gLat += (lat - this.gLat) * k;
    this.gLong += (long - this.gLong) * k;
    if (!track) return;
    if (this.gVert > this.maxG) this.maxG = this.gVert;
    if (this.gVert < this.minG) this.minG = this.gVert;
    const al = Math.abs(this.gLat);
    if (al > this.maxLat) this.maxLat = al;
    if (!this.driven && this.gVert < AIRTIME_G) this.airtime += dt;
    if (this.gVert > G_LIMITS.vertMax || this.gVert < G_LIMITS.vertMin || al > G_LIMITS.lateral) this.overGTime += dt;
  }

  /** 현재까지의 통계로 기록을 만든다 */
  record(): RideRecord {
    const completed = this.status === 'finished';
    const rideTime = this.status === 'running' ? this.t : this.endTime;
    const distance = Math.min(this.s, this.track.length);
    const base = {
      completed,
      rideTime,
      maxSpeed: this.maxSpeed,
      avgSpeed: rideTime > 0 ? distance / rideTime : 0,
      maxG: this.maxG,
      minG: this.minG,
      maxLateralG: this.maxLat,
      airtime: this.airtime,
      inversions: this.inversions,
      maxDrop: this.maxDrop,
      maxHeight: this.maxHeight,
      trackLength: this.track.length,
      overGTime: this.overGTime,
      stallAt: this.status === 'stalled' ? this.s : null,
    };
    return { ...base, thrill: computeThrill(base), recordedAt: new Date().toISOString() };
  }
}

export interface SimulationResult {
  record: RideRecord;
  /** 멈춘 위치(m). 완주하면 null */
  stallAt: number | null;
  /** 샘플별 통과 속력(m/s). profile 을 요청했을 때만. 도달하지 못한 샘플은 0 */
  speed: Float32Array | null;
}

/** 탑승 전체를 즉시 계산한다(설계 화면의 예측, 자동 뱅킹, 테스트에서 사용) */
export function simulateRide(track: Track, params: PhysicsParams = DEFAULT_PHYSICS, profile = false): SimulationResult {
  const sim = new RideSim(track, params);
  const speed = profile ? new Float32Array(track.count) : null;
  while (sim.status === 'running') {
    sim.step();
    if (speed && sim.s < track.length) speed[track.indexAt(sim.s)] = sim.v;
  }
  const record = sim.record();
  return { record, stallAt: record.stallAt, speed };
}
