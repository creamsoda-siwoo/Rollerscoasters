import * as THREE from 'three';
import './style.css';
import { AudioEngine } from './core/audio';
import { World } from './core/world';
import { Editor } from './editor/editor';
import type { EditorHost } from './editor/editor';
import { simulateRide } from './physics/simulation';
import type { SimulationResult } from './physics/simulation';
import { fetchCourse, submitRecord, uploadTrack } from './online/api';
import type { TrackRow, TrackSort } from './online/api';
import { OFFLINE_MESSAGE, onlineEnabled } from './online/client';
import { Session, describeError } from './online/session';
import { Ride } from './ride/ride';
import { createDefaultCourse, createStarterCourse, deserializeCourse, serializeCourse, uid } from './track/course';
import { buildTrack } from './track/spline';
import type { Track } from './track/spline';
import * as storage from './track/storage';
import { TrackView } from './track/trackMesh';
import type { CourseData, RideRecord } from './track/types';
import { DesignPanel } from './ui/designPanel';
import { closeModal, confirmDialog, isModalOpen, showJsonDialog, showLoadDialog, showResult } from './ui/dialogs';
import { $, isTyping } from './ui/dom';
import { Hud } from './ui/hud';
import { ratingWidget, showAccountDialog, showBrowse, showUploadDialog } from './ui/online';
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
  private readonly session = new Session();
  /** 남의 코스를 타는 중이면 그 코스와, 잠시 치워 둔 내 설계 */
  private guest: { track: TrackRow; own: CourseData } | null = null;
  private browseTab: TrackSort = 'popular';
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
    window.addEventListener('pagehide', () => storage.saveAutosave(this.guest?.own ?? this.course));
    // 탭이 가려지면 화면이 멈추므로 소리도 멈춘다
    document.addEventListener('visibilitychange', () => this.audio.setSuspended(document.hidden));

    $('btn-browse').addEventListener('click', () => this.openBrowse());
    $('btn-publish').addEventListener('click', () => void this.publish());
    $('btn-account').addEventListener('click', () => this.openAccount());
    this.initOnline();

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

  // ── 온라인(Supabase) ──────────────────────────────────────────────────────

  private initOnline(): void {
    const button = $('btn-account');
    if (!onlineEnabled) {
      button.textContent = '오프라인';
      return;
    }
    button.textContent = '접속 중…';
    this.session.onChange((account) => {
      button.textContent = account ? account.nickname : '계정';
      button.classList.toggle('guest', account?.anonymous === true);
    });
    // 익명 로그인으로 바로 시작한다. 실패해도 게임은 오프라인으로 계속 쓸 수 있다.
    this.session.ensure().catch((err) => {
      button.textContent = '접속 실패';
      console.warn('[coaster] 로그인 실패:', err);
    });
  }

  /** 온라인 기능을 쓸 수 있는지 확인하고, 안 되면 이유를 알린다 */
  private async requireAccount() {
    if (!onlineEnabled) {
      toast(OFFLINE_MESSAGE, 'error');
      return null;
    }
    try {
      const account = await this.session.ensure();
      if (!account) toast('로그인하지 못했습니다', 'error');
      return account;
    } catch (err) {
      toast(`서버에 접속하지 못했습니다: ${describeError(err)}`, 'error');
      return null;
    }
  }

  private openAccount(): void {
    void this.requireAccount().then((account) => {
      if (account) showAccountDialog(this.session, toast);
    });
  }

  private openBrowse(): void {
    if (!onlineEnabled) {
      toast(OFFLINE_MESSAGE, 'error');
      return;
    }
    showBrowse({
      session: this.session,
      initial: this.browseTab,
      onTab: (tab) => (this.browseTab = tab),
      onPlay: (track) => void this.playRemote(track),
      onRemix: (track) => void this.remix(track),
      notify: toast,
    });
  }

  /** 현재 코스를 화면 캡처와 함께 서버에 올린다 */
  private async publish(): Promise<void> {
    const account = await this.requireAccount();
    if (!account) return;
    if (!this.prediction?.record.completed) {
      toast('완주할 수 있는 코스만 올릴 수 있습니다. 먼저 설계를 고쳐 주세요.', 'error');
      return;
    }
    // 손잡이를 숨기고 지금 화면을 찍는다
    this.editor.setOverlayVisible(false);
    const thumbnail = await this.world.capture(480, 270);
    this.editor.setOverlayVisible(true);
    const course = this.course;
    showUploadDialog({
      title: course.name,
      update: !!course.remoteId,
      thumbnail,
      onSubmit: async (title, isPublic) => {
        try {
          const id = await uploadTrack({ course, title, isPublic, thumbnail, userId: account.id });
          course.remoteId = id;
          course.name = title.trim().slice(0, 60) || course.name;
          storage.saveAutosave(course);
          this.refreshInfo();
          toast(isPublic ? '코스를 올렸습니다. 둘러보기에서 볼 수 있습니다.' : '비공개로 올렸습니다.');
        } catch (err) {
          toast(`올리지 못했습니다: ${describeError(err)}`, 'error');
          throw err;
        }
      },
    });
  }

  /** 서버의 코스를 받아 바로 탄다. 내 설계는 그대로 두었다가 끝나면 되돌린다. */
  private async playRemote(track: TrackRow): Promise<void> {
    if (this.mode !== 'design') return;
    let course: CourseData;
    try {
      course = await fetchCourse(track.id);
    } catch (err) {
      toast(`코스를 받지 못했습니다: ${describeError(err)}`, 'error');
      return;
    }
    closeModal();
    this.guest = { track, own: this.course };
    this.course = course;
    this.rebuild();
    this.world.terrain.clearTreesAlong(this.track);
    this.startRide();
  }

  /** 서버의 코스를 내 설계로 복사해 편집한다 */
  private async remix(track: TrackRow): Promise<void> {
    try {
      const course = await fetchCourse(track.id);
      course.id = uid();
      course.name = `${course.name} (복사)`.slice(0, 60);
      closeModal();
      this.setCourse(course);
      toast(`“${track.title}” 을 내 설계로 복사했습니다`);
    } catch (err) {
      toast(`코스를 받지 못했습니다: ${describeError(err)}`, 'error');
    }
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
    const guest = this.guest;
    if (guest) {
      // 남의 코스를 탔으면 내 설계를 되돌려 놓는다
      this.guest = null;
      this.course = guest.own;
      this.rebuild();
      this.predict();
      this.world.terrain.clearTreesAlong(this.track);
    }
    this.editor.setActive(true);
    this.editor.refresh();
    this.refreshInfo();
    this.panel.refresh();
    if (guest) this.openBrowse();
  }

  private onRideEnd(record: RideRecord): void {
    const guest = this.guest;
    if (guest) {
      const account = this.session.account;
      if (record.completed && account) {
        submitRecord(guest.track.id, account.id, record)
          .then(() => toast('탑승 기록을 남겼습니다'))
          .catch((err) => toast(`기록을 남기지 못했습니다: ${describeError(err)}`, 'error'));
      }
      showResult(
        record,
        {
          retry: () => {
            closeModal();
            this.ride.start(this.track);
          },
          design: () => this.exitRide(),
          showStall: () => this.exitRide(),
        },
        { extra: ratingWidget(guest.track, account, toast), backLabel: '둘러보기로' },
      );
      return;
    }
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
