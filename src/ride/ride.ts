import * as THREE from 'three';
import type { AudioEngine } from '../core/audio';
import { StallMarker } from '../core/markers';
import type { World } from '../core/world';
import { G_LIMITS } from '../physics/scoring';
import { DEFAULT_PHYSICS, RideSim } from '../physics/simulation';
import { createFrame } from '../track/spline';
import type { Track } from '../track/spline';
import type { RideRecord } from '../track/types';
import { EYE_LOCAL, Train } from './train';

export type CameraMode = 'first' | 'chase';

/** HUD 가 매 프레임 읽어 가는 값 */
export interface RideHud {
  /** km/h */
  speed: number;
  gVert: number;
  gLat: number;
  time: number;
  /** 0..1 */
  progress: number;
  height: number;
  /** 0..1, 화면 가장자리를 붉게 하는 정도 */
  danger: number;
  onChain: boolean;
  camera: CameraMode;
}

export interface RideCallbacks {
  /** 완주했거나 멈췄을 때 한 번 */
  onEnd: (record: RideRecord) => void;
}

/** 체인 리프트 딸깍 간격(m) */
const CLICK_SPACING = 0.42;
/** 실패 후 결과 화면을 띄우기까지의 뜸(초) */
const FAIL_DELAY = 1.1;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * 탑승 모드: 물리 시뮬레이션을 실시간으로 돌리며 열차·카메라·소리·HUD 값을 갱신한다.
 */
export class Ride {
  readonly hud: RideHud = {
    speed: 0,
    gVert: 1,
    gLat: 0,
    time: 0,
    progress: 0,
    height: 0,
    danger: 0,
    onChain: false,
    camera: 'first',
  };
  cameraMode: CameraMode = 'first';
  /** 테스트·디버그용 배속 */
  timeScale = 1;

  private sim: RideSim | null = null;
  private track: Track | null = null;
  private readonly train = new Train();
  private readonly marker = new StallMarker();
  private readonly f = createFrame();
  private readonly ahead = createFrame();
  private readonly eye = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly upVec = new THREE.Vector3();
  private readonly chasePos = new THREE.Vector3();
  private chaseReady = false;
  private fov = 70;
  private ended = false;
  private endTimer = 0;
  private lastClick = 0;
  private clock = 0;

  constructor(
    private readonly world: World,
    private readonly audio: AudioEngine,
    private readonly callbacks: RideCallbacks,
  ) {
    this.train.group.visible = false;
    world.scene.add(this.train.group, this.marker.group);
  }

  get active(): boolean {
    return this.sim !== null;
  }

  start(track: Track): void {
    this.track = track;
    this.sim = new RideSim(track, DEFAULT_PHYSICS);
    this.ended = false;
    this.endTimer = 0;
    this.lastClick = 0;
    this.chaseReady = false;
    this.marker.hide();
    this.train.group.visible = true;
    this.train.place(track, 0);
    this.fov = this.cameraMode === 'first' ? 70 : 58;
    this.update(0);
  }

  stop(): void {
    this.sim = null;
    this.track = null;
    this.train.group.visible = false;
    this.marker.hide();
    this.audio.silence();
  }

  toggleCamera(): CameraMode {
    this.cameraMode = this.cameraMode === 'first' ? 'chase' : 'first';
    this.chaseReady = false;
    return this.cameraMode;
  }

  update(dt: number): void {
    const sim = this.sim;
    const track = this.track;
    if (!sim || !track) return;
    this.clock += dt;

    sim.advance(dt * this.timeScale);
    this.train.place(track, sim.s);
    const f = track.frameAt(sim.s, this.f);

    // 소리
    this.audio.setSpeed(sim.status === 'stalled' ? 0 : sim.v);
    if (sim.status === 'running' && f.chain && sim.s - this.lastClick >= CLICK_SPACING) {
      this.lastClick = sim.s;
      this.audio.click();
    }

    // 종료 판정
    if (!this.ended && sim.status !== 'running') {
      if (sim.status === 'stalled') {
        if (this.endTimer === 0) this.marker.show(this.eye.copy(f.pos).addScaledVector(f.up, 2.4));
        this.endTimer += dt;
      }
      if (sim.status === 'finished' || this.endTimer >= FAIL_DELAY) {
        this.ended = true;
        this.callbacks.onEnd(sim.record());
      }
    }
    this.marker.update(dt);

    this.updateCamera(dt, track, sim);

    // HUD
    const h = this.hud;
    h.speed = sim.v * 3.6;
    h.gVert = sim.gVert;
    h.gLat = sim.gLat;
    h.time = sim.status === 'running' ? sim.t : sim.endTime;
    h.progress = Math.min(1, sim.s / track.length);
    h.height = f.pos.y - this.world.terrain.heightAt(f.pos.x, f.pos.z);
    h.onChain = sim.status === 'running' && f.chain;
    h.camera = this.cameraMode;
    // G 가 한계에 가까워질수록 붉어진다
    const danger = Math.max(
      smoothstep(G_LIMITS.vertMax - 1.5, G_LIMITS.vertMax + 0.8, sim.gVert),
      smoothstep(-(G_LIMITS.vertMin + 1.0), -(G_LIMITS.vertMin - 0.8), -sim.gVert),
      smoothstep(G_LIMITS.lateral - 0.7, G_LIMITS.lateral + 0.6, Math.abs(sim.gLat)),
    );
    h.danger += (danger - h.danger) * (1 - Math.exp(-dt * 10));
    if (sim.status !== 'running') h.danger *= Math.exp(-dt * 4);
  }

  private updateCamera(dt: number, track: Track, sim: RideSim): void {
    const cam = this.world.camera;
    const f = this.f;
    const speedK = smoothstep(4, 40, sim.v);
    let targetFov: number;

    if (this.cameraMode === 'first') {
      // 눈 위치 = 맨 앞 차량 앞줄 좌석
      this.eye
        .copy(f.pos)
        .addScaledVector(f.right, EYE_LOCAL.x)
        .addScaledVector(f.up, EYE_LOCAL.y)
        .addScaledVector(f.tan, -EYE_LOCAL.z);
      // 고속에서 미세한 떨림
      const shake = 0.012 * speedK;
      this.eye
        .addScaledVector(f.right, Math.sin(this.clock * 47.3) * shake)
        .addScaledVector(f.up, Math.sin(this.clock * 61.7 + 1.3) * shake);
      // 조금 앞의 레일을 바라보면 커브 안쪽으로 시선이 자연스럽게 돌아간다
      const a = track.frameAt(sim.s + 5, this.ahead);
      this.target
        .copy(a.pos)
        .addScaledVector(a.right, EYE_LOCAL.x)
        .addScaledVector(a.up, EYE_LOCAL.y)
        .sub(this.eye)
        .normalize()
        .lerp(f.tan, 0.45)
        .normalize();
      this.upVec.copy(f.up).lerp(a.up, 0.25).normalize();
      cam.position.copy(this.eye);
      cam.up.copy(this.upVec);
      cam.lookAt(this.target.add(this.eye));
      targetFov = 70 + 28 * speedK;
      this.world.setShadowFocus(f.pos, 90);
    } else {
      // 열차 뒤 위쪽에서 따라가는 카메라
      const b = track.frameAt(sim.s - 14, this.ahead);
      // 레일에 가려지지 않게 살짝 옆에서 비스듬히 본다
      this.target.copy(b.pos).addScaledVector(b.up, 3.8).addScaledVector(b.right, 2.4);
      this.target.y += 1.4;
      const ground = this.world.terrain.heightAt(this.target.x, this.target.z) + 1.2;
      if (this.target.y < ground) this.target.y = ground;
      if (!this.chaseReady) {
        this.chasePos.copy(this.target);
        this.chaseReady = true;
      } else {
        this.chasePos.lerp(this.target, 1 - Math.exp(-dt * 5));
      }
      cam.position.copy(this.chasePos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.target.copy(f.pos).addScaledVector(f.up, 0.9));
      targetFov = 58 + 16 * speedK;
      this.world.setShadowFocus(f.pos, 110);
    }

    this.fov += (targetFov - this.fov) * (1 - Math.exp(-dt * 3));
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
