import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { StallMarker } from '../core/markers';
import { BUILD_RADIUS } from '../core/terrain';
import type { World } from '../core/world';
import { computeAutoBank } from '../physics/autobank';
import { makePoint } from '../track/course';
import { PRESET_LABEL, buildPreset } from '../track/presets';
import type { PresetKind } from '../track/presets';
import { createFrame, wrapDeg } from '../track/spline';
import type { Track } from '../track/spline';
import { BANK_LIMIT, MIN_POINTS } from '../track/types';
import type { ControlPoint, CourseData } from '../track/types';
import { History } from './history';

export type Tool = 'select' | 'add';

/** 제어점이 지면에서 떨어져 있어야 하는 최소 높이(m) */
export const MIN_CLEARANCE = 0.6;
/** 제어점 최대 높이(m, 지면 기준) */
export const MAX_HEIGHT = 110;

export interface EditorHost {
  readonly course: CourseData;
  readonly track: Track;
  /**
   * 편집기가 course.points 를 바꾼 뒤 호출한다.
   * live=true 는 드래그·슬라이더 조작 도중, designChanged 는 확정된 설계가 실제로 달라졌는지.
   */
  onEdit(live: boolean, designChanged: boolean): void;
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface EditorState {
  tool: Tool;
  /** 선택된 제어점 번호. 없으면 -1 */
  selectedIndex: number;
  selected: ControlPoint | null;
  /** 선택된 점의 지면 위 높이(m) */
  selectedHeight: number;
  pointCount: number;
  canUndo: boolean;
  canRedo: boolean;
  canDelete: boolean;
}

interface Drag {
  pointerId: number;
  id: string;
  kind: 'move' | 'height';
  startX: number;
  startY: number;
  moved: boolean;
  /** move: 제어점 − 최초 교점 */
  offsetX: number;
  offsetZ: number;
  /** height: 시작 높이와 픽셀당 미터 */
  startHeight: number;
  unitsPerPixel: number;
}

interface Press {
  pointerId: number;
  x: number;
  y: number;
  time: number;
  touch: boolean;
}

type Pick = { kind: 'point'; index: number } | { kind: 'gizmo' };

const HANDLE_PX_MOUSE = 6.5;
const HANDLE_PX_TOUCH = 7.5;
const DRAG_THRESHOLD = 4;
const CLICK_SLOP = 7;

function handleMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.96 });
}

/**
 * 설계 모드. 제어점 추가/이동/삭제, 뱅킹·체인 지정, 프리셋 삽입, 실행취소, 궤도 카메라를 맡는다.
 * 제어점 데이터 자체는 host.course.points 에 있고, 편집기는 그것을 고친 뒤 host.onEdit 을 부른다.
 */
export class Editor {
  tool: Tool = 'select';
  /** 선택·도구·실행취소 가능 여부가 바뀔 때 호출된다 */
  onStateChange: () => void = () => {};
  readonly controls: OrbitControls;
  readonly stallMarker = new StallMarker();

  private selectedId: string | null = null;
  private hoverIndex = -1;
  private active = true;
  private readonly coarse = window.matchMedia('(pointer: coarse)').matches;

  private readonly root = new THREE.Group();
  private readonly handles: THREE.Mesh[] = [];
  private readonly handleGeo = new THREE.SphereGeometry(1, 18, 12);
  private readonly matNormal = handleMaterial(0xf4f7ff);
  private readonly matChain = handleMaterial(0xf2b632);
  private readonly matStart = handleMaterial(0x35d07f);
  private readonly matSelected = handleMaterial(0x21c7f5);
  private readonly stems: THREE.LineSegments;
  private readonly gizmo = new THREE.Group();

  private readonly history = new History<ControlPoint[]>();
  private drag: Drag | null = null;
  private press: Press | null = null;
  private readonly pointers = new Set<number>();

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly plane = new THREE.Plane();
  private readonly v = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly frame = createFrame();
  private readonly saved = { position: new THREE.Vector3(), target: new THREE.Vector3(), valid: false };

  constructor(
    private readonly world: World,
    private readonly host: EditorHost,
  ) {
    const canvas = world.canvas;
    this.controls = new OrbitControls(world.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 700;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = false;

    this.stems = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 }),
    );
    this.stems.frustumCulled = false;
    this.root.add(this.stems);

    // 높이 조절 손잡이(위아래 화살표)
    const gizmoMat = handleMaterial(0xffe14d);
    const up = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.5, 12).translate(0, 1.15, 0), gizmoMat);
    const down = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.5, 12).rotateX(Math.PI).translate(0, -1.15, 0), gizmoMat);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.2, 8), gizmoMat);
    for (const m of [up, down, shaft]) {
      m.renderOrder = 12;
      this.gizmo.add(m);
    }
    this.gizmo.visible = false;
    this.root.add(this.gizmo);

    world.scene.add(this.root, this.stallMarker.group);

    // 캡처 단계에서 먼저 받아, 손잡이를 잡았을 때 궤도 카메라가 반응하지 않게 한다
    canvas.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    canvas.addEventListener('pointermove', this.onPointerMove, { capture: true });
    canvas.addEventListener('pointerup', this.onPointerUp, { capture: true });
    canvas.addEventListener('pointercancel', this.onPointerUp, { capture: true });
    canvas.addEventListener('pointerleave', () => this.setHover(-1));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ── 상태 ───────────────────────────────────────────────────────────────────

  private get points(): ControlPoint[] {
    return this.host.course.points;
  }

  get selectedIndex(): number {
    return this.selectedId ? this.points.findIndex((p) => p.id === this.selectedId) : -1;
  }

  getState(): EditorState {
    const index = this.selectedIndex;
    const selected = index >= 0 ? this.points[index] : null;
    return {
      tool: this.tool,
      selectedIndex: index,
      selected,
      selectedHeight: selected ? selected.y - this.world.terrain.heightAt(selected.x, selected.z) : 0,
      pointCount: this.points.length,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      canDelete: selected !== null && this.points.length > MIN_POINTS,
    };
  }

  /** 새 코스를 불러온 뒤 호출: 기록·선택을 초기화한다 */
  reset(): void {
    this.selectedId = null;
    this.hoverIndex = -1;
    this.drag = null;
    this.history.reset(this.points);
    this.refresh();
    this.frameCourse();
    this.onStateChange();
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    const cam = this.world.camera;
    if (!active) {
      this.saved.position.copy(cam.position);
      this.saved.target.copy(this.controls.target);
      this.saved.valid = true;
      this.cancelDrag();
      this.press = null;
      this.pointers.clear();
    } else if (this.saved.valid) {
      cam.position.copy(this.saved.position);
      cam.up.set(0, 1, 0);
      cam.fov = 55;
      cam.updateProjectionMatrix();
      this.controls.target.copy(this.saved.target);
    }
    this.active = active;
    this.controls.enabled = active;
    this.root.visible = active;
    this.world.canvas.style.cursor = '';
    if (active) this.controls.update();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.updateCursor();
    this.onStateChange();
  }

  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.refresh();
    this.onStateChange();
  }

  selectStep(delta: number): void {
    const n = this.points.length;
    const i = this.selectedIndex;
    const next = i < 0 ? 0 : (i + delta + n) % n;
    this.select(this.points[next].id);
  }

  // ── 편집 명령 ──────────────────────────────────────────────────────────────

  /** 확정: 기록에 쌓고 호스트에 알린다 */
  private commit(): void {
    const changed = this.history.push(this.points);
    this.refresh();
    this.host.onEdit(false, changed);
    this.onStateChange();
  }

  private live(): void {
    this.refresh();
    this.host.onEdit(true, false);
  }

  undo(): void {
    const state = this.history.undo();
    if (state) this.restore(state);
  }

  redo(): void {
    const state = this.history.redo();
    if (state) this.restore(state);
  }

  private restore(points: ControlPoint[]): void {
    this.host.course.points = points;
    if (this.selectedIndex < 0) this.selectedId = null;
    this.refresh();
    this.host.onEdit(false, true);
    this.onStateChange();
  }

  /** 선택한 점의 지면 위 높이를 바꾼다 */
  setHeight(height: number, live: boolean): void {
    const p = this.points[this.selectedIndex];
    if (!p) return;
    const ground = this.world.terrain.heightAt(p.x, p.z);
    p.y = ground + Math.min(MAX_HEIGHT, Math.max(MIN_CLEARANCE, height));
    if (live) this.live();
    else this.commit();
  }

  setBank(bank: number, live: boolean): void {
    const p = this.points[this.selectedIndex];
    if (!p) return;
    p.bank = Math.min(BANK_LIMIT, Math.max(-BANK_LIMIT, bank));
    if (live) this.live();
    else this.commit();
  }

  setChain(chain: boolean): void {
    const p = this.points[this.selectedIndex];
    if (!p) return;
    p.chain = chain;
    this.commit();
  }

  deleteSelected(): void {
    const i = this.selectedIndex;
    if (i < 0) return;
    if (this.points.length <= MIN_POINTS) {
      this.host.notify(`제어점은 최소 ${MIN_POINTS}개가 필요합니다`, 'error');
      return;
    }
    this.points.splice(i, 1);
    this.selectedId = this.points[(i - 1 + this.points.length) % this.points.length].id;
    this.commit();
  }

  /** 선택한 제어점을 진입점으로 삼아 그 뒤에 프리셋 부품을 끼워 넣는다 */
  insertPreset(kind: PresetKind): void {
    const i = this.selectedIndex;
    if (i < 0) {
      this.host.notify('부품을 넣을 위치의 제어점을 먼저 선택하세요', 'error');
      return;
    }
    const p = this.points[i];
    const track = this.host.track;
    const f = track.frameAt(track.pointS[i], this.frame);
    let hx = f.tan.x;
    let hz = f.tan.z;
    let hl = Math.hypot(hx, hz);
    if (hl < 0.2) {
      // 진입점이 수직에 가까우면 다음 점 쪽을 진행 방향으로 본다
      const next = this.points[(i + 1) % this.points.length];
      hx = next.x - p.x;
      hz = next.z - p.z;
      hl = Math.hypot(hx, hz);
      if (hl < 1e-3) {
        hx = 1;
        hz = 0;
        hl = 1;
      }
    }
    const result = buildPreset(kind, {
      origin: p,
      heading: { x: hx / hl, z: hz / hl },
      groundAt: (x, z) => this.world.terrain.heightAt(x, z),
      bounds: BUILD_RADIUS,
    });
    if (!result.ok) {
      this.host.notify(result.error, 'error');
      return;
    }
    const added = result.points;
    hx /= hl;
    hz /= hl;

    // 부품이 차지하는 자리에 있던 뒤쪽 제어점은 치운다(그대로 두면 레일이 급하게 꺾인다).
    // 출발점(0번)은 건드리지 않도록 배열 끝에서 멈춘다.
    let cx = p.x;
    let cz = p.z;
    for (const q of added) {
      cx += q.x;
      cz += q.z;
    }
    cx /= added.length + 1;
    cz /= added.length + 1;
    let reach = Math.hypot(p.x - cx, p.z - cz);
    let forwardMax = 0;
    for (const q of added) {
      reach = Math.max(reach, Math.hypot(q.x - cx, q.z - cz));
      forwardMax = Math.max(forwardMax, (q.x - p.x) * hx + (q.z - p.z) * hz);
    }
    let overlap = 0;
    for (let j = i + 1; j < this.points.length; j++) {
      const q = this.points[j];
      const forward = (q.x - p.x) * hx + (q.z - p.z) * hz;
      if (forward < -3 || forward > forwardMax + 8 || Math.hypot(q.x - cx, q.z - cz) > reach + 12) break;
      overlap++;
    }

    this.points.splice(i + 1, overlap, ...added);
    this.selectedId = added[added.length - 1].id;
    this.commit();
    this.host.notify(
      overlap > 0
        ? `${PRESET_LABEL[kind]} 삽입 — 자리가 겹치는 제어점 ${overlap}개를 정리했습니다`
        : `${PRESET_LABEL[kind]} 삽입 완료 — 이어지는 제어점을 다듬어 보세요`,
    );
  }

  /** 예상 속도에 맞춰 모든 제어점의 뱅킹을 다시 계산한다 */
  autoBank(): void {
    const banks = computeAutoBank(this.points, this.host.track);
    this.points.forEach((p, i) => {
      p.bank = banks[i];
    });
    this.commit();
    this.host.notify('예상 속도에 맞춰 뱅킹을 계산했습니다');
  }

  // ── 카메라 ─────────────────────────────────────────────────────────────────

  /** 코스 전체가 보이도록 카메라를 놓는다 */
  frameCourse(): void {
    const box = new THREE.Box3();
    for (const p of this.points) box.expandByPoint(this.v.set(p.x, p.y, p.z));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(40, box.getSize(this.v).length() / 2);
    const cam = this.world.camera;
    // 세로로 긴 화면에서는 가로 시야가 좁으므로 더 물러난다
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2))) * Math.max(0.75, 0.85 / cam.aspect);
    this.controls.target.set(center.x, Math.min(center.y, 12), center.z);
    cam.position.copy(this.controls.target).add(this.v.set(-0.5, 0.52, 0.7).normalize().multiplyScalar(dist));
    cam.up.set(0, 1, 0);
    this.controls.update();
  }

  /** 특정 위치를 가까이서 보도록 카메라를 옮긴다 */
  focusOn(position: THREE.Vector3, distance = 70): void {
    const cam = this.world.camera;
    const offset = this.v.copy(cam.position).sub(this.controls.target);
    offset.setLength(Math.min(offset.length(), distance));
    this.controls.target.copy(position);
    cam.position.copy(position).add(offset);
    this.controls.update();
  }

  // ── 매 프레임 ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    if (!this.active) return;
    this.controls.update();
    const cam = this.world.camera;
    // 카메라가 땅속으로 들어가지 않게
    const floor = this.world.terrain.heightAt(cam.position.x, cam.position.z) + 1.5;
    if (cam.position.y < floor) cam.position.y = floor;

    // 손잡이를 화면에서 일정한 크기로 유지
    const px = this.coarse ? HANDLE_PX_TOUCH : HANDLE_PX_MOUSE;
    const perPixel = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / this.world.canvas.clientHeight;
    const selected = this.selectedIndex;
    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i];
      let s = h.position.distanceTo(cam.position) * perPixel * px;
      if (i === selected) s *= 1.35;
      else if (i === this.hoverIndex) s *= 1.2;
      h.scale.setScalar(s);
    }
    if (selected >= 0) {
      const h = this.handles[selected];
      const unit = h.position.distanceTo(cam.position) * perPixel * px;
      this.gizmo.visible = true;
      this.gizmo.position.copy(h.position);
      this.gizmo.position.y += unit * 4.6;
      this.gizmo.scale.setScalar(unit * 0.95);
    } else {
      this.gizmo.visible = false;
    }

    this.stallMarker.update(dt);
    const dist = cam.position.distanceTo(this.controls.target);
    this.world.setShadowFocus(this.controls.target, Math.min(340, Math.max(80, dist * 0.95)));
  }

  /** 제어점 배열에 맞춰 손잡이·기둥선을 갱신한다 */
  refresh(): void {
    const pts = this.points;
    while (this.handles.length < pts.length) {
      const mesh = new THREE.Mesh(this.handleGeo, this.matNormal);
      mesh.renderOrder = 10;
      this.handles.push(mesh);
      this.root.add(mesh);
    }
    while (this.handles.length > pts.length) {
      const mesh = this.handles.pop()!;
      this.root.remove(mesh);
    }
    const stem = new Float32Array(pts.length * 6);
    const selected = this.selectedIndex;
    pts.forEach((p, i) => {
      const h = this.handles[i];
      h.position.set(p.x, p.y, p.z);
      h.material =
        i === selected ? this.matSelected : i === 0 ? this.matStart : p.chain ? this.matChain : this.matNormal;
      stem.set([p.x, p.y, p.z, p.x, this.world.terrain.heightAt(p.x, p.z), p.z], i * 6);
    });
    this.stems.geometry.dispose();
    this.stems.geometry = new THREE.BufferGeometry();
    this.stems.geometry.setAttribute('position', new THREE.BufferAttribute(stem, 3));
    if (this.hoverIndex >= pts.length) this.hoverIndex = -1;
  }

  // ── 포인터 입력 ────────────────────────────────────────────────────────────

  private localXY(e: PointerEvent): { x: number; y: number } {
    const rect = this.world.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private setRay(x: number, y: number): THREE.Ray {
    const canvas = this.world.canvas;
    this.ndc.set((x / canvas.clientWidth) * 2 - 1, -(y / canvas.clientHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.world.camera);
    return this.raycaster.ray;
  }

  /** 월드 좌표 → 화면 픽셀. 카메라 뒤면 null */
  private toScreen(p: THREE.Vector3): { x: number; y: number } | null {
    const canvas = this.world.canvas;
    this.v2.copy(p).project(this.world.camera);
    if (this.v2.z < -1 || this.v2.z > 1) return null;
    return { x: (this.v2.x * 0.5 + 0.5) * canvas.clientWidth, y: (-this.v2.y * 0.5 + 0.5) * canvas.clientHeight };
  }

  private pick(x: number, y: number, touch: boolean): Pick | null {
    const slop = touch ? 24 : 10;
    const radius = touch ? HANDLE_PX_TOUCH : HANDLE_PX_MOUSE;
    if (this.gizmo.visible) {
      const s = this.toScreen(this.gizmo.position);
      if (s && Math.hypot(s.x - x, s.y - y) < radius * 2.4 + slop * 0.6) return { kind: 'gizmo' };
    }
    let best = -1;
    let bestD = radius + slop;
    for (let i = 0; i < this.handles.length; i++) {
      const s = this.toScreen(this.handles[i].position);
      if (!s) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? { kind: 'point', index: best } : null;
  }

  /** 화면상에서 레일에 가장 가까운 지점의 호 길이. 너무 멀면 null */
  private pickRail(x: number, y: number, slop: number): number | null {
    const track = this.host.track;
    const stride = Math.max(1, Math.round(1 / track.step));
    let best = -1;
    let bestD = slop;
    for (let k = 0; k < track.count; k += stride) {
      const s = this.toScreen(this.v.set(track.pos[k * 3], track.pos[k * 3 + 1], track.pos[k * 3 + 2]));
      if (!s) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best >= 0 ? best * track.step : null;
  }

  private setHover(index: number): void {
    if (this.hoverIndex === index) return;
    this.hoverIndex = index;
    this.updateCursor();
  }

  private updateCursor(hoverGizmo = false): void {
    const canvas = this.world.canvas;
    if (!this.active) canvas.style.cursor = '';
    else if (this.drag) canvas.style.cursor = this.drag.kind === 'height' ? 'ns-resize' : 'grabbing';
    else if (hoverGizmo) canvas.style.cursor = 'ns-resize';
    else if (this.hoverIndex >= 0) canvas.style.cursor = 'grab';
    else canvas.style.cursor = this.tool === 'add' ? 'crosshair' : '';
  }

  private cancelDrag(): void {
    if (!this.drag) return;
    const moved = this.drag.moved;
    this.drag = null;
    this.controls.enabled = this.active;
    if (moved) this.commit();
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.active) return;
    this.pointers.add(e.pointerId);
    if (this.pointers.size > 1) {
      // 두 손가락 제스처(확대·이동)가 시작되면 편집 동작은 접는다
      this.cancelDrag();
      this.press = null;
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const touch = e.pointerType !== 'mouse';
    const { x, y } = this.localXY(e);
    const hit = this.pick(x, y, touch);
    if (!hit) {
      this.press = { pointerId: e.pointerId, x, y, time: performance.now(), touch };
      return;
    }

    // 손잡이를 잡았다: 궤도 카메라를 잠그고 드래그 준비
    this.controls.enabled = false;
    let index: number;
    let kind: Drag['kind'];
    if (hit.kind === 'gizmo') {
      index = this.selectedIndex;
      kind = 'height';
    } else {
      index = hit.index;
      kind = e.shiftKey ? 'height' : 'move';
      this.select(this.points[index].id);
    }
    const p = this.points[index];
    const cam = this.world.camera;
    const depth = this.v.set(p.x, p.y, p.z).sub(cam.position).dot(cam.getWorldDirection(this.v2));
    const unitsPerPixel =
      (2 * Math.max(1, depth) * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / this.world.canvas.clientHeight;
    let offsetX = 0;
    let offsetZ = 0;
    this.plane.set(this.v.set(0, 1, 0), -p.y);
    const first = this.setRay(x, y).intersectPlane(this.plane, this.v);
    if (first) {
      offsetX = p.x - first.x;
      offsetZ = p.z - first.z;
    }
    this.drag = {
      pointerId: e.pointerId,
      id: p.id,
      kind,
      startX: x,
      startY: y,
      moved: false,
      offsetX,
      offsetZ,
      startHeight: p.y,
      unitsPerPixel,
    };
    try {
      this.world.canvas.setPointerCapture(e.pointerId);
    } catch {
      // 일부 브라우저의 합성 이벤트에서는 실패할 수 있다
    }
    this.updateCursor();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.active) return;
    const { x, y } = this.localXY(e);
    const drag = this.drag;
    if (drag && e.pointerId === drag.pointerId) {
      if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) < DRAG_THRESHOLD) return;
      drag.moved = true;
      const p = this.points.find((q) => q.id === drag.id);
      if (!p) return;
      const terrain = this.world.terrain;
      if (drag.kind === 'height' || e.shiftKey) {
        const ground = terrain.heightAt(p.x, p.z);
        const y1 = drag.startHeight + (drag.startY - y) * drag.unitsPerPixel;
        p.y = Math.min(ground + MAX_HEIGHT, Math.max(ground + MIN_CLEARANCE, y1));
      } else {
        this.plane.set(this.v.set(0, 1, 0), -p.y);
        const ray = this.setRay(x, y);
        const hit = ray.intersectPlane(this.plane, this.v);
        if (!hit || hit.distanceTo(ray.origin) > 1600) return;
        p.x = Math.min(BUILD_RADIUS, Math.max(-BUILD_RADIUS, hit.x + drag.offsetX));
        p.z = Math.min(BUILD_RADIUS, Math.max(-BUILD_RADIUS, hit.z + drag.offsetZ));
        p.y = Math.max(p.y, terrain.heightAt(p.x, p.z) + MIN_CLEARANCE);
      }
      this.live();
      this.onStateChange();
      return;
    }
    if (this.press && e.pointerId === this.press.pointerId) {
      if (Math.hypot(x - this.press.x, y - this.press.y) > CLICK_SLOP) this.press = null;
    }
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      const hit = this.pick(x, y, false);
      this.hoverIndex = hit?.kind === 'point' ? hit.index : -1;
      this.updateCursor(hit?.kind === 'gizmo');
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (!this.active) return;
    const drag = this.drag;
    if (drag && e.pointerId === drag.pointerId) {
      this.drag = null;
      this.controls.enabled = true;
      this.updateCursor();
      if (drag.moved) this.commit();
      return;
    }
    const press = this.press;
    if (press && e.pointerId === press.pointerId) {
      this.press = null;
      if (e.type === 'pointerup' && performance.now() - press.time < 700) this.handleClick(press.x, press.y, press.touch);
    }
  };

  private handleClick(x: number, y: number, touch: boolean): void {
    if (this.tool !== 'add') {
      this.select(null);
      return;
    }
    const railS = this.pickRail(x, y, touch ? 20 : 10);
    if (railS !== null) {
      this.insertOnRail(railS);
      return;
    }
    const hit = this.world.terrain.raycast(this.setRay(x, y), 2500, this.v);
    if (!hit) return;
    if (Math.abs(hit.x) > BUILD_RADIUS || Math.abs(hit.z) > BUILD_RADIUS) {
      this.host.notify('건설 구역(흰 테두리) 안쪽에만 놓을 수 있습니다', 'error');
      return;
    }
    this.addPointAt(hit.x, hit.z);
  }

  /** 지면 클릭: 선택한 점(없으면 마지막 점) 뒤에 새 제어점을 잇는다 */
  private addPointAt(x: number, z: number): void {
    const pts = this.points;
    const after = this.selectedIndex >= 0 ? this.selectedIndex : pts.length - 1;
    const ref = pts[after];
    const terrain = this.world.terrain;
    const refHeight = ref.y - terrain.heightAt(ref.x, ref.z);
    const y = terrain.heightAt(x, z) + Math.min(60, Math.max(2.5, refHeight));
    const point = makePoint(x, y, z);
    pts.splice(after + 1, 0, point);
    this.selectedId = point.id;
    this.commit();
  }

  /** 레일 클릭: 그 자리에 제어점을 끼워 넣어 구간을 나눈다 */
  private insertOnRail(s: number): void {
    const pts = this.points;
    const f = this.host.track.frameAt(s, this.frame);
    const a = pts[f.seg];
    const b = pts[(f.seg + 1) % pts.length];
    const near = (q: ControlPoint) => Math.hypot(q.x - f.pos.x, q.y - f.pos.y, q.z - f.pos.z) < 2;
    if (near(a) || near(b)) {
      this.select(near(a) ? a.id : b.id);
      return;
    }
    const point = makePoint(f.pos.x, f.pos.y, f.pos.z, Math.round(wrapDeg(f.bank)), a.chain);
    pts.splice(f.seg + 1, 0, point);
    this.selectedId = point.id;
    this.commit();
  }
}
