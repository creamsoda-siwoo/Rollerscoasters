import type { Editor } from '../editor/editor';
import type { SimulationResult } from '../physics/simulation';
import type { PresetKind } from '../track/presets';
import type { Track } from '../track/spline';
import type { CourseData } from '../track/types';
import { $ } from './dom';
import { duration, fixed, kmh } from './format';

export interface DesignActions {
  ride(): void;
  newCourse(): void;
  save(): void;
  load(): void;
  json(): void;
  rename(name: string): void;
  /** 예상 정지 지점으로 카메라 이동 */
  showStall(): void;
}

/** 설계 모드의 상단 바·도구 막대·속성 패널을 편집기에 연결한다 */
export class DesignPanel {
  private readonly name = $<HTMLInputElement>('course-name');
  private readonly toolSelect = $<HTMLButtonElement>('tool-select');
  private readonly toolAdd = $<HTMLButtonElement>('tool-add');
  private readonly undo = $<HTMLButtonElement>('btn-undo');
  private readonly redo = $<HTMLButtonElement>('btn-redo');
  private readonly presets: Record<PresetKind, HTMLButtonElement> = {
    loop: $<HTMLButtonElement>('preset-loop'),
    corkscrew: $<HTMLButtonElement>('preset-corkscrew'),
    drop: $<HTMLButtonElement>('preset-drop'),
  };
  private readonly title = $('point-title');
  private readonly empty = $('point-empty');
  private readonly fields = $('point-fields');
  private readonly height = $<HTMLInputElement>('in-height');
  private readonly heightOut = $('out-height');
  private readonly bank = $<HTMLInputElement>('in-bank');
  private readonly bankOut = $('out-bank');
  private readonly chain = $<HTMLInputElement>('in-chain');
  private readonly del = $<HTMLButtonElement>('btn-delete');
  private readonly hint = $('hint');
  private readonly coarse = window.matchMedia('(pointer: coarse)').matches;

  constructor(
    private readonly editor: Editor,
    actions: DesignActions,
  ) {
    $('btn-ride').addEventListener('click', () => actions.ride());
    $('btn-new').addEventListener('click', () => actions.newCourse());
    $('btn-save').addEventListener('click', () => actions.save());
    $('btn-load').addEventListener('click', () => actions.load());
    $('btn-json').addEventListener('click', () => actions.json());

    this.name.addEventListener('change', () => actions.rename(this.name.value));
    this.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') this.name.blur();
    });

    this.toolSelect.addEventListener('click', () => editor.setTool('select'));
    this.toolAdd.addEventListener('click', () => editor.setTool('add'));
    this.undo.addEventListener('click', () => editor.undo());
    this.redo.addEventListener('click', () => editor.redo());
    for (const kind of Object.keys(this.presets) as PresetKind[]) {
      this.presets[kind].addEventListener('click', () => editor.insertPreset(kind));
    }
    $('btn-autobank').addEventListener('click', () => editor.autoBank());
    $('btn-frame').addEventListener('click', () => editor.frameCourse());
    $('btn-prev').addEventListener('click', () => editor.selectStep(-1));
    $('btn-next').addEventListener('click', () => editor.selectStep(1));

    // 슬라이더: 끄는 동안은 미리보기(live), 놓으면 확정
    this.height.addEventListener('input', () => {
      const v = Number(this.height.value);
      this.heightOut.textContent = `${v.toFixed(1)} m`;
      editor.setHeight(v, true);
    });
    this.height.addEventListener('change', () => editor.setHeight(Number(this.height.value), false));
    this.bank.addEventListener('input', () => {
      const v = Number(this.bank.value);
      this.bankOut.textContent = `${v.toFixed(0)}°`;
      editor.setBank(v, true);
    });
    this.bank.addEventListener('change', () => editor.setBank(Number(this.bank.value), false));
    this.chain.addEventListener('change', () => editor.setChain(this.chain.checked));
    $('btn-bank-zero').addEventListener('click', () => editor.setBank(0, false));
    this.del.addEventListener('click', () => editor.deleteSelected());

    $('prediction').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).tagName === 'A') actions.showStall();
    });
  }

  /** 편집기 상태(선택·도구·실행취소)를 화면에 반영 */
  refresh(): void {
    const s = this.editor.getState();
    this.toolSelect.classList.toggle('active', s.tool === 'select');
    this.toolAdd.classList.toggle('active', s.tool === 'add');
    this.undo.disabled = !s.canUndo;
    this.redo.disabled = !s.canRedo;
    for (const b of Object.values(this.presets)) b.disabled = !s.selected;

    this.empty.hidden = !!s.selected;
    this.fields.hidden = !s.selected;
    if (s.selected) {
      this.title.textContent =
        s.selectedIndex === 0 ? '제어점 1 · 출발' : `제어점 ${s.selectedIndex + 1} / ${s.pointCount}`;
      // 사용자가 끌고 있는 슬라이더는 덮어쓰지 않는다
      if (document.activeElement !== this.height) this.height.value = s.selectedHeight.toFixed(1);
      this.heightOut.textContent = `${s.selectedHeight.toFixed(1)} m`;
      if (document.activeElement !== this.bank) this.bank.value = String(s.selected.bank);
      this.bankOut.textContent = `${s.selected.bank.toFixed(0)}°`;
      this.chain.checked = s.selected.chain;
      this.del.disabled = !s.canDelete;
    } else {
      this.title.textContent = '제어점';
    }

    if (this.coarse) {
      this.hint.innerHTML = '';
    } else if (s.tool === 'add') {
      this.hint.innerHTML =
        '<b>지면 클릭</b> 선택한 점 뒤에 추가 · <b>레일 클릭</b> 그 자리에 끼워 넣기 · <b>드래그</b> 화면 회전';
    } else {
      this.hint.innerHTML =
        '<b>점 드래그</b> 이동 · <b>Shift+드래그</b>/<b>노란 화살표</b> 높이 · <b>좌 드래그</b> 회전 · <b>우 드래그</b> 이동 · <b>휠</b> 줌';
    }
  }

  /** 코스 이름·길이·예측 결과 표시 */
  setCourseInfo(course: CourseData, track: Track, prediction: SimulationResult | null, warning = ''): void {
    const warn = $('warning');
    warn.hidden = !warning;
    warn.textContent = warning;
    if (document.activeElement !== this.name) this.name.value = course.name;
    let top = -Infinity;
    for (const p of course.points) top = Math.max(top, p.y);
    $('stat-length').textContent = `${track.length.toFixed(0)} m`;
    $('stat-height').textContent = `${top.toFixed(0)} m`;
    $('stat-points').textContent = `${course.points.length}`;

    const box = $('prediction');
    if (!prediction) {
      box.hidden = true;
    } else {
      box.hidden = false;
      const r = prediction.record;
      box.classList.toggle('fail', !r.completed);
      if (r.completed) {
        box.innerHTML = `<strong>완주 가능</strong>예상 최고 ${kmh(r.maxSpeed)} km/h · 최대 ${fixed(r.maxG)} G · ${duration(r.rideTime)}`;
      } else {
        const at = (prediction.stallAt ?? 0).toFixed(0);
        box.innerHTML = `<strong>완주 불가</strong>출발 후 ${at} m 지점에서 속도가 부족해 멈춥니다. <a>위치 보기</a>`;
      }
    }

    const rec = course.record;
    $('record-line').textContent =
      rec && rec.completed
        ? `탑승 기록 · 스릴 ${rec.thrill}점 · 최고 ${kmh(rec.maxSpeed)} km/h · 최대 ${fixed(rec.maxG)} G · ${duration(rec.rideTime)}`
        : '아직 이 설계로 완주한 기록이 없습니다.';
  }
}
