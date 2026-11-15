import { G_LIMITS, thrillGrade } from '../physics/scoring';
import type { CourseSummary } from '../track/storage';
import type { RideRecord } from '../track/types';
import { $, el } from './dom';
import { dateTime, duration, fixed, kmh } from './format';

/** 모달은 한 번에 하나만 띄운다 */
let closeCurrent: (() => void) | null = null;

export function isModalOpen(): boolean {
  return closeCurrent !== null;
}

export function closeModal(): void {
  closeCurrent?.();
}

interface ModalOptions {
  wide?: boolean;
  /** 배경을 옅게(뒤 장면이 보이도록) */
  light?: boolean;
  /** 배경 클릭·Esc 로 닫을 때 호출. 없으면 그런 방식으로는 닫히지 않는다 */
  onDismiss?: () => void;
}

function openModal(content: HTMLElement[], options: ModalOptions = {}): () => void {
  closeModal();
  const card = el('div', { class: `modal panel ${options.wide ? 'wide' : ''}`, role: 'dialog' }, ...content);
  const backdrop = el('div', { class: `backdrop ${options.light ? 'light' : ''}` }, card);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && options.onDismiss) {
      e.stopPropagation();
      options.onDismiss();
    }
  };
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop && options.onDismiss) options.onDismiss();
  });
  window.addEventListener('keydown', onKey, true);
  const close = () => {
    if (closeCurrent !== close) return;
    closeCurrent = null;
    window.removeEventListener('keydown', onKey, true);
    backdrop.remove();
  };
  closeCurrent = close;
  $('modal-root').append(backdrop);
  return close;
}

function stat(label: string, value: string, unit = '', key = false): HTMLElement {
  return el('div', { class: key ? 'key' : '' }, el('dt', {}, label), el('dd', {}, value, unit ? el('small', {}, unit) : null));
}

// ── 탑승 결과 ────────────────────────────────────────────────────────────────

export function showResult(
  record: RideRecord,
  actions: { retry: () => void; design: () => void; showStall: () => void },
): void {
  const ok = record.completed;
  const grade = thrillGrade(record.thrill);
  const head = el(
    'div',
    { class: 'result-head' },
    el('div', { class: `grade ${ok ? '' : 'fail'}` }, ok ? grade.grade : '!'),
    el(
      'div',
      {},
      el('h1', {}, ok ? '탑승 완료' : '탑승 실패'),
      ok
        ? el('div', { class: 'result-score' }, `${record.thrill}`, el('small', {}, `스릴 점수 · ${grade.label}`))
        : el('div', { class: 'muted' }, '열차가 한 바퀴를 돌지 못했습니다'),
    ),
  );

  const grid = el(
    'dl',
    { class: 'result-grid' },
    stat('최고 속도', kmh(record.maxSpeed), 'km/h', true),
    stat('최대 G', fixed(record.maxG), 'G', true),
    stat('탑승 시간', duration(record.rideTime), '', true),
    stat('스릴 점수', ok ? `${record.thrill}` : '–', ok ? '점' : '', true),
    stat('최소 G', fixed(record.minG), 'G'),
    stat('최대 횡 G', fixed(record.maxLateralG), 'G'),
    stat('에어타임', fixed(record.airtime), '초'),
    stat('인버전', `${record.inversions}`, '회'),
    stat('최대 낙차', record.maxDrop.toFixed(0), 'm'),
    stat('최고 높이', record.maxHeight.toFixed(0), 'm'),
    stat('트랙 길이', record.trackLength.toFixed(0), 'm'),
    stat('평균 속도', kmh(record.avgSpeed), 'km/h'),
  );
  grid.style.margin = '0';

  const notes: HTMLElement[] = [];
  if (!ok) {
    notes.push(
      el(
        'div',
        { class: 'note' },
        `출발 후 ${(record.stallAt ?? 0).toFixed(0)} m 지점에서 속도가 부족해 멈췄습니다. ` +
          '그 앞의 오르막을 낮추거나, 더 높은 곳에서 내려오도록 고쳐 보세요.',
      ),
    );
  } else if (record.overGTime > 0.05) {
    notes.push(
      el(
        'div',
        { class: 'note' },
        `한계(수직 ${G_LIMITS.vertMin}~${G_LIMITS.vertMax} G, 횡 ${G_LIMITS.lateral} G)를 넘는 힘이 ` +
          `${fixed(record.overGTime)}초 동안 걸려 스릴 점수가 깎였습니다. 곡선을 완만하게 하거나 뱅킹을 조절해 보세요.`,
      ),
    );
  }

  const buttons = el(
    'div',
    { class: 'modal-actions' },
    el('button', { class: 'btn', onclick: actions.retry }, '다시 탑승'),
    ok
      ? el('button', { class: 'btn primary', onclick: actions.design }, '설계로 돌아가기')
      : el('button', { class: 'btn primary', onclick: actions.showStall }, '멈춘 위치 보기'),
  );

  openModal([head, grid, ...notes, buttons], { light: true });
}

// ── 확인 ────────────────────────────────────────────────────────────────────

export function confirmDialog(title: string, message: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      close();
      resolve(value);
    };
    const close = openModal(
      [
        el('h1', {}, title),
        el('p', {}, message),
        el(
          'div',
          { class: 'modal-actions' },
          el('button', { class: 'btn', onclick: () => finish(false) }, '취소'),
          el('button', { class: 'btn primary', onclick: () => finish(true) }, okLabel),
        ),
      ],
      { onDismiss: () => finish(false) },
    );
  });
}

// ── 불러오기 ────────────────────────────────────────────────────────────────

export function showLoadDialog(options: {
  list: () => CourseSummary[];
  currentId: string;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}): void {
  const listEl = el('div', { class: 'slot-list' });
  const render = () => {
    listEl.replaceChildren();
    const items = options.list();
    if (items.length === 0) {
      listEl.append(el('p', {}, '저장된 코스가 없습니다. 상단의 “저장”을 누르면 이 브라우저에 보관됩니다.'));
      return;
    }
    for (const item of items) {
      const rec = item.record;
      const meta =
        `${dateTime(item.updatedAt)} · 제어점 ${item.pointCount}개` +
        (rec && rec.completed ? ` · 스릴 ${rec.thrill}점` : '');
      listEl.append(
        el(
          'div',
          { class: `slot ${item.id === options.currentId ? 'current' : ''}` },
          el('div', { class: 'slot-info' }, el('div', { class: 'slot-name' }, item.name), el('div', { class: 'slot-meta' }, meta)),
          el('button', { class: 'btn small', onclick: () => options.onLoad(item.id) }, '불러오기'),
          el(
            'button',
            {
              class: 'btn small danger',
              onclick: () => {
                options.onDelete(item.id);
                render();
              },
            },
            '삭제',
          ),
        ),
      );
    }
  };
  render();
  const close = openModal(
    [
      el('h1', {}, '코스 불러오기'),
      el('p', {}, '이 브라우저(localStorage)에 저장된 코스입니다.'),
      listEl,
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close() }, '닫기')),
    ],
    { wide: true, onDismiss: () => close() },
  );
}

// ── JSON 내보내기/가져오기 ──────────────────────────────────────────────────

export function showJsonDialog(options: {
  json: string;
  fileName: string;
  /** 가져오기. 실패하면 오류 메시지를, 성공하면 null 을 돌려준다 */
  onImport: (text: string) => string | null;
  notify: (message: string, kind?: 'info' | 'error') => void;
}): void {
  const area = el('textarea', { class: 'json', spellcheck: false }) as HTMLTextAreaElement;
  area.value = options.json;
  const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    area.value = await f.text();
    file.value = '';
    options.notify('파일을 읽었습니다. “이 JSON 적용”을 누르면 코스가 바뀝니다.');
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(area.value);
      options.notify('JSON 을 클립보드에 복사했습니다');
    } catch {
      area.select();
      options.notify('복사 권한이 없어 전체 선택만 했습니다. Ctrl+C 로 복사하세요.', 'error');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([area.value], { type: 'application/json' }));
    const a = el('a', { href: url, download: options.fileName });
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const apply = () => {
    const error = options.onImport(area.value);
    if (error) options.notify(error, 'error');
    else close();
  };

  const close = openModal(
    [
      el('h1', {}, '코스 JSON'),
      el('p', {}, '코스 전체가 이 JSON 하나에 들어 있습니다. 복사·저장해 두었다가 붙여 넣어 되살릴 수 있습니다.'),
      area,
      file,
      el(
        'div',
        { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: copy }, '복사'),
        el('button', { class: 'btn', onclick: download }, '파일로 저장'),
        el('button', { class: 'btn', onclick: () => file.click() }, '파일 열기'),
        el('button', { class: 'btn primary', onclick: apply }, '이 JSON 적용'),
        el('button', { class: 'btn', onclick: () => close() }, '닫기'),
      ),
    ],
    { wide: true, onDismiss: () => close() },
  );
}
