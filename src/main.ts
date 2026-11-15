import * as THREE from 'three';
import './style.css';
import { AudioEngine } from './core/audio';
import { World } from './core/world';
import { Editor } from './editor/editor';
import type { EditorHost } from './editor/editor';
import { simulateRide } from './physics/simulation';
import type { SimulationResult } from './physics/simulation';
import { Ride } from './ride/ride';
import { createDefaultCourse, createStarterCourse, deserializeCourse, serializeCourse } from './track/course';
import { buildTrack } from './track/spline';
import type { Track } from './track/spline';
import * as storage from './track/storage';
import { TrackView } from './track/trackMesh';
import type { CourseData, RideRecord } from './track/types';
import { DesignPanel } from './ui/designPanel';
import { closeModal, confirmDialog, isModalOpen, showJsonDialog, showLoadDialog, showResult } from './ui/dialogs';
import { $, isTyping } from './ui/dom';
import { Hud } from './ui/hud';
import { toast } from './ui/toast';

type Mode = 'design' | 'ride';

/** 드래그 중 예측 시뮬레이션을 다시 돌리는 최소 간격(ms) */
const LIVE_PREDICT_INTERVAL = 140;

/**
 * 앱 전체를 잇는 곳. 코스 데이터와 그로부터 만든 트랙을 들고 있고,
 * 설계 모드(Editor)와 탑승 모드(Ride) 사이를 오간다.
 */
class App implements EditorHost {
  course: CourseData;
  track: Track;
  mode: Mode = 'design';

  readonly world: World;
  readonly editor: Editor;
  readonly ride: Ride;
  private readonly audio = new AudioEngine();
  private readonly trackView: TrackView;
  private readonly panel: DesignPanel;
  private readonly hud = new Hud();
  private prediction: SimulationResult | null = null;
  private warning = '';
  private lastPredict = 0;
  private predictPending = false;
  private liveDirty = false;
  private lastFrame = performance.now();
  private readonly tmp = new THREE.Vector3();

  constructor() {
    this.world = new World($('viewport'));
    this.course = storage.loadAutosave() ?? createDefaultCourse();
    this.track = buildTrack(this.course.points);

    this.trackView = new TrackView((x, z) => this.world.terrain.heightAt(x, z));
    this.world.scene.add(this.trackView.group);

    this.editor = new Editor(this.world, this);
    this.ride = new Ride(this.world, this.audio, { onEnd: (record) => this.onRideEnd(record) });
    this.panel = new DesignPanel(this.editor, {
      ride: () => this.startRide(),
      newCourse: () => void this.newCourse(),
      save: () => this.save(),
      load: () => this.openLoadDialog(),
      json: () => this.openJsonDialog(),
      rename: (name) => this.rename(name),
      showStall: () => this.focusStall(),
    });
    this.editor.onStateChange = () => this.panel.refresh();

    $('btn-camera').addEventListener('click', () => this.ride.toggleCamera());
    $('btn-mute').addEventListener('click', () => this.toggleMute());
    $('btn-exit').addEventListener('click', () => this.exitRide());
    window.addEventListener('keydown', (e) => this.onKey(e));
    // 탭을 떠날 때 마지막 상태를 남긴다
    window.addEventListener('pagehide', () => storage.saveAutosave(this.course));
    // 탭이 가려지면 화면이 멈추므로 소리도 멈춘다
    document.addEventListener('visibilitychange', () => this.audio.setSuspended(document.hidden));

    this.applyCourse();
    requestAnimationFrame(this.frame);
  }

  // ── 코스/트랙 ──────────────────────────────────────────────────────────────

  /** 코스를 통째로 바꾼 뒤(불러오기·새 코스) 모든 것을 다시 만든다 */
  private applyCourse(): void {
    this.rebuild();
    this.predict();
    this.world.terrain.clearTreesAlong(this.track);
    this.editor.reset();
    this.refreshInfo();
  }

  private rebuild(): void {
    this.track = buildTrack(this.course.points);
    this.trackView.update(this.track);
  }

  /** 탑승 결과를 미리 계산해 설계 화면에 알려 준다 */
  private predict(): void {
    this.prediction = simulateRide(this.track);
    this.checkClearance();
    this.lastPredict = performance.now();
    this.predictPending = false;
    const stall = this.prediction.stallAt;
    if (stall !== null) {
      this.track.positionAt(stall, this.tmp);
      this.tmp.y += 2.4;
      this.editor.stallMarker.show(this.tmp);
    } else {
      this.editor.stallMarker.hide();
    }
  }

  private refreshInfo(): void {
    this.panel.setCourseInfo(this.course, this.track, this.prediction, this.warning);
  }

  /** 레일(아래쪽 구조물 포함)이 지면에 묻히는 곳이 있는지 */
  private checkClearance(): void {
    const { pos, count, step } = this.track;
    const stride = Math.max(1, Math.round(1 / step));
    let buried = 0;
    for (let k = 0; k < count; k += stride) {
      if (pos[k * 3 + 1] - this.world.terrain.heightAt(pos[k * 3], pos[k * 3 + 2]) < 0.4) buried++;
    }
    const meters = Math.max(1, Math.round(buried * stride * step));
    this.warning =
      buried > 0 ? `레일이 약 ${meters} m 구간에서 지면 아래로 내려갑니다. 그 부근 제어점을 올려 주세요.` : '';
  }

  // EditorHost
  onEdit(live: boolean, designChanged: boolean): void {
    if (live) {
      // 드래그 중에는 포인터 이벤트가 프레임보다 자주 오므로, 다시 만들기는 프레임당 한 번으로 모은다
      this.liveDirty = true;
      return;
    }
    this.liveDirty = false;
    this.rebuild();
    this.predict();
    this.world.terrain.clearTreesAlong(this.track);
    if (designChanged) {
      // 설계가 달라졌으니 이전 탑승 기록은 더 이상 유효하지 않다
      this.course.record = null;
      this.course.updatedAt = new Date().toISOString();
      storage.saveAutosave(this.course);
    }
    this.refreshInfo();
  }

  notify(message: string, kind: 'info' | 'error' = 'info'): void {
    toast(message, kind);
  }

  // ── 저장/불러오기 ──────────────────────────────────────────────────────────

  private rename(name: string): void {
    const trimmed = name.trim().slice(0, 60) || '이름 없는 코스';
    this.course.name = trimmed;
    this.course.updatedAt = new Date().toISOString();
    storage.saveAutosave(this.course);
    this.refreshInfo();
  }

  private save(): void {
    try {
      this.course.updatedAt = new Date().toISOString();
      storage.saveCourse(this.course);
      storage.saveAutosave(this.course);
      toast(`“${this.course.name}” 저장 완료`);
    } catch (err) {
      toast(err instanceof Error ? err.message : '저장하지 못했습니다', 'error');
    }
  }

  private setCourse(course: CourseData): void {
    this.course = course;
    storage.saveAutosave(course);
    this.applyCourse();
  }

  private async newCourse(): Promise<void> {
    const ok = await confirmDialog(
      '새 코스를 시작할까요?',
      '지금 코스 대신 기본 순환 코스에서 다시 시작합니다. 저장하지 않은 변경은 사라집니다.',
      '새로 시작',
    );
    if (ok) this.setCourse(createStarterCourse());
  }

  private openLoadDialog(): void {
    showLoadDialog({
      list: () => storage.listCourses(),
      currentId: this.course.id,
      onLoad: (id) => {
        const course = storage.loadCourse(id);
        if (!course) {
          toast('코스를 읽지 못했습니다', 'error');
          return;
        }
        closeModal();
        this.setCourse(course);
        toast(`“${course.name}” 불러옴`);
      },
      onDelete: (id) => storage.deleteCourse(id),
    });
  }

  private openJsonDialog(): void {
    showJsonDialog({
      json: serializeCourse(this.course, true),
      fileName: `${this.course.name.replace(/[\\/:*?"<>|\s]+/g, '_') || 'course'}.json`,
      notify: toast,
      onImport: (text) => {
        try {
          const imported = deserializeCourse(text);
          this.setCourse(imported);
          toast(`“${imported.name}” 가져오기 완료`);
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : 'JSON 을 읽지 못했습니다';
        }
      },
    });
  }

  // ── 모드 전환 ──────────────────────────────────────────────────────────────

  private startRide(): void {
    if (this.mode === 'ride') {
      this.ride.start(this.track);
      return;
    }
    closeModal();
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.mode = 'ride';
    this.audio.start();
    this.editor.setActive(false);
    $('design-ui').hidden = true;
    $('ride-ui').hidden = false;
    document.body.classList.add('riding');
    this.hud.reset();
    this.ride.start(this.track);
  }

  private exitRide(): void {
    if (this.mode !== 'ride') return;
    closeModal();
    this.ride.stop();
    this.mode = 'design';
    $('ride-ui').hidden = true;
    $('design-ui').hidden = false;
    document.body.classList.remove('riding');
    this.editor.setActive(true);
    this.refreshInfo();
    this.panel.refresh();
  }

  private onRideEnd(record: RideRecord): void {
    if (record.completed) {
      this.course.record = record;
      storage.saveAutosave(this.course);
    }
    showResult(record, {
      retry: () => {
        closeModal();
        this.ride.start(this.track);
      },
      design: () => this.exitRide(),
      showStall: () => {
        this.exitRide();
        this.focusStall();
      },
    });
  }

  private focusStall(): void {
    const stall = this.prediction?.stallAt;
    if (stall === null || stall === undefined) return;
    this.editor.focusOn(this.track.positionAt(stall, this.tmp), 80);
  }

  private toggleMute(): void {
    this.audio.setMuted(!this.audio.isMuted);
    $('btn-mute').textContent = this.audio.isMuted ? '소리 꺼짐' : '소리 켜짐';
  }

  // ── 단축키 ────────────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent): void {
    if (isTyping()) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // 버튼에 포커스가 있을 때의 Enter/Space 는 그 버튼의 몫이다
    if ((key === 'enter' || key === ' ') && document.activeElement?.tagName === 'BUTTON') return;

    if (this.mode === 'ride') {
      if (key === 'c') this.ride.toggleCamera();
      else if (key === 'm') this.toggleMute();
      else if (key === 'escape') this.exitRide();
      else if (key === 'r') {
        closeModal();
        this.ride.start(this.track);
      }
      return;
    }
    if (isModalOpen()) return;

    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.editor.redo();
      else this.editor.undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      this.editor.redo();
    } else if (mod && key === 's') {
      e.preventDefault();
      this.save();
    } else if (mod) {
      return;
    } else if (key === 'delete' || key === 'backspace') {
      e.preventDefault();
      this.editor.deleteSelected();
    } else if (key === 'v' || key === '1') this.editor.setTool('select');
    else if (key === 'a' || key === '2') this.editor.setTool('add');
    else if (key === 'escape') this.editor.select(null);
    else if (key === '[') this.editor.selectStep(-1);
    else if (key === ']') this.editor.selectStep(1);
    else if (key === 'f') this.editor.frameCourse();
    else if (key === 'enter') this.startRide();
  }

  // ── 메인 루프 ─────────────────────────────────────────────────────────────

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    // 탭이 숨어 있다 돌아와도 물리가 한꺼번에 튀지 않게 상한을 둔다
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;

    if (this.mode === 'design') {
      if (this.liveDirty) {
        this.liveDirty = false;
        this.rebuild();
        this.predictPending = true;
        this.refreshInfo();
      }
      // 예측 시뮬레이션은 드래그 중 가끔만 돌린다
      if (this.predictPending && now - this.lastPredict > LIVE_PREDICT_INTERVAL) {
        this.predict();
        this.refreshInfo();
      }
      this.editor.update(dt);
    } else {
      this.ride.update(dt);
      this.hud.update(this.ride.hud);
    }
    this.world.render(dt);
  };
}

const app = new App();
if (import.meta.env.DEV) {
  // 개발 중 콘솔에서 들여다보기 위한 손잡이
  (window as unknown as { coaster: App }).coaster = app;
}
