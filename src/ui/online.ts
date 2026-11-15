import { PAGE_SIZE, deleteTrack, listTracks, myRating, rateTrack } from '../online/api';
import type { TrackRow, TrackSort } from '../online/api';
import { supabase } from '../online/client';
import { NICKNAME_MAX, describeError } from '../online/session';
import type { Account, Session } from '../online/session';
import { thrillGrade } from '../physics/scoring';
import { confirmDialog, openModal } from './dialogs';
import { el } from './dom';
import { dateTime } from './format';

type Notify = (message: string, kind?: 'info' | 'error') => void;

/** 썸네일은 우리 Storage 버킷 주소일 때만 보여 준다(남이 넣은 임의의 외부 주소로 요청이 나가지 않게) */
function safeThumbnail(url: string | null): string | null {
  if (!url || !supabase) return null;
  const prefix = supabase.storage.from('thumbnails').getPublicUrl('').data.publicUrl;
  return url.startsWith(prefix) ? url : null;
}

function stars(value: number): string {
  const n = Math.round(value);
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

// ── 둘러보기 ─────────────────────────────────────────────────────────────────

const TABS: { key: TrackSort; label: string }[] = [
  { key: 'popular', label: '인기순' },
  { key: 'recent', label: '최신순' },
  { key: 'rating', label: '평점순' },
  { key: 'thrill', label: '스릴 리더보드' },
  { key: 'mine', label: '내 코스' },
];

export interface BrowseOptions {
  session: Session;
  /** 마지막으로 보던 탭 */
  initial?: TrackSort;
  onTab?: (tab: TrackSort) => void;
  onPlay: (track: TrackRow) => void;
  /** 내 설계로 복사해 편집 */
  onRemix: (track: TrackRow) => void;
  notify: Notify;
}

export function showBrowse(options: BrowseOptions): void {
  const { session, notify } = options;
  let tab: TrackSort = options.initial ?? 'popular';
  let page = 0;
  let token = 0;

  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const list = el('div', { class: 'browse-list' });
  const more = el('button', { class: 'btn', hidden: true }, '더 보기');
  const status = el('p', { class: 'browse-status' });

  const card = (t: TrackRow): HTMLElement => {
    const mine = session.account?.id === t.user_id;
    const thumb = safeThumbnail(t.thumbnail_url);
    const meta = el(
      'div',
      { class: 'card-meta' },
      el('span', { class: 'rating', title: `평점 ${t.avg_rating.toFixed(2)} (${t.rating_count}명)` }, `★ ${t.rating_count ? t.avg_rating.toFixed(1) : '–'}`),
      el('span', {}, `탑승 ${t.play_count}`),
      t.best_thrill > 0 ? el('span', {}, `스릴 ${t.best_thrill}`) : null,
    );
    const actions = el(
      'div',
      { class: 'card-actions' },
      el('button', { class: 'btn small primary', onclick: () => options.onPlay(t) }, '타보기'),
      el('button', { class: 'btn small', onclick: () => options.onRemix(t), title: '내 설계로 복사해서 고치기' }, '복사'),
      mine
        ? el(
            'button',
            {
              class: 'btn small danger',
              onclick: async () => {
                const ok = await confirmDialog('코스를 삭제할까요?', `“${t.title}” 과 그 평점·기록이 서버에서 지워집니다.`, '삭제');
                if (ok) {
                  try {
                    await deleteTrack(t);
                    notify('삭제했습니다');
                  } catch (err) {
                    notify(describeError(err), 'error');
                  }
                }
                // 확인 창이 둘러보기를 닫았으므로 다시 연다
                showBrowse({ ...options, initial: tab });
              },
            },
            '삭제',
          )
        : null,
    );
    return el(
      'article',
      { class: 'track-card' },
      el(
        'div',
        { class: 'thumb' },
        thumb ? el('img', { src: thumb, alt: '', loading: 'lazy', decoding: 'async' }) : el('div', { class: 'thumb-empty' }, '미리보기 없음'),
        !t.is_public ? el('span', { class: 'badge' }, '비공개') : null,
      ),
      el('h3', { title: t.title }, t.title),
      el('div', { class: 'card-author' }, `${t.author}${mine ? ' (나)' : ''} · ${dateTime(t.created_at).slice(0, 10)}`),
      meta,
      actions,
    );
  };

  const rankRow = (t: TrackRow, rank: number): HTMLElement => {
    const thumb = safeThumbnail(t.thumbnail_url);
    const grade = thrillGrade(t.best_thrill);
    return el(
      'div',
      { class: `rank-row ${rank <= 3 ? 'top' : ''}` },
      el('div', { class: 'rank' }, `${rank}`),
      el('div', { class: 'rank-thumb' }, thumb ? el('img', { src: thumb, alt: '', loading: 'lazy' }) : null),
      el(
        'div',
        { class: 'rank-info' },
        el('div', { class: 'rank-title' }, t.title),
        el('div', { class: 'card-author' }, `${t.author} · ★ ${t.rating_count ? t.avg_rating.toFixed(1) : '–'} · 탑승 ${t.play_count}`),
      ),
      el('div', { class: 'rank-score' }, `${t.best_thrill}`, el('small', {}, `${grade.grade} · ${grade.label}`)),
      el('button', { class: 'btn small primary', onclick: () => options.onPlay(t) }, '타보기'),
    );
  };

  const load = async (reset: boolean): Promise<void> => {
    const mine = ++token;
    if (reset) {
      page = 0;
      list.replaceChildren();
      list.className = tab === 'thrill' ? 'browse-list ranks' : 'browse-list';
    }
    more.hidden = true;
    status.textContent = '불러오는 중…';
    try {
      const account = await session.ensure();
      const rows = await listTracks(tab, page, account?.id ?? null);
      if (mine !== token) return; // 그 사이 탭이 바뀌었다
      const offset = page * PAGE_SIZE;
      rows.forEach((r, i) => list.append(tab === 'thrill' ? rankRow(r, offset + i + 1) : card(r)));
      more.hidden = rows.length < PAGE_SIZE;
      status.textContent =
        list.children.length > 0
          ? ''
          : tab === 'mine'
            ? '아직 올린 코스가 없습니다. 설계 화면의 “올리기”로 공유해 보세요.'
            : tab === 'thrill'
              ? '아직 완주 기록이 있는 코스가 없습니다.'
              : '아직 공개된 코스가 없습니다. 첫 코스를 올려 보세요!';
    } catch (err) {
      if (mine !== token) return;
      status.textContent = `불러오지 못했습니다: ${describeError(err)}`;
    }
  };

  const renderTabs = (): void => {
    tabs.replaceChildren(
      ...TABS.map((t) =>
        el(
          'button',
          {
            class: `tab ${t.key === tab ? 'active' : ''}`,
            role: 'tab',
            onclick: () => {
              if (tab === t.key) return;
              tab = t.key;
              options.onTab?.(tab);
              renderTabs();
              void load(true);
            },
          },
          t.label,
        ),
      ),
    );
  };

  more.addEventListener('click', () => {
    page++;
    void load(false);
  });

  const close = openModal(
    [
      el(
        'div',
        { class: 'browse-head' },
        el('h1', {}, '코스 둘러보기'),
        el('button', { class: 'btn', onclick: () => close() }, '닫기'),
      ),
      tabs,
      list,
      status,
      el('div', { class: 'browse-more' }, more),
    ],
    { full: true, onDismiss: () => close() },
  );
  renderTabs();
  void load(true);
}

// ── 평점(결과 화면에 끼워 넣는 조각) ───────────────────────────────────────────

export function ratingWidget(track: TrackRow, account: Account | null, notify: Notify): HTMLElement {
  const box = el('div', { class: 'rate-box' });
  const label = el('div', { class: 'rate-label' }, `“${track.title}” — ${track.author}`);
  if (!account) {
    box.append(label, el('div', { class: 'muted small-text' }, '로그인되지 않아 평점을 남길 수 없습니다.'));
    return box;
  }
  if (account.id === track.user_id) {
    box.append(
      label,
      el('div', { class: 'muted small-text' }, `내가 올린 코스입니다 · 평점 ${stars(track.avg_rating)} (${track.rating_count}명)`),
    );
    return box;
  }
  const hint = el('div', { class: 'muted small-text' }, '이 코스는 어땠나요? 별을 눌러 평점을 남겨 주세요.');
  const row = el('div', { class: 'star-row', role: 'radiogroup', 'aria-label': '평점' });
  let current = 0;
  let busy = false;
  const buttons = [1, 2, 3, 4, 5].map((n) =>
    el(
      'button',
      {
        class: 'star',
        role: 'radio',
        'aria-label': `${n}점`,
        onclick: async () => {
          if (busy) return;
          busy = true;
          const before = current;
          paint(n);
          try {
            await rateTrack(track.id, n);
            current = n;
            hint.textContent = `${n}점을 남겼습니다. 다시 눌러 고칠 수 있습니다.`;
          } catch (err) {
            paint(before);
            notify(`평점을 남기지 못했습니다: ${describeError(err)}`, 'error');
          }
          busy = false;
        },
      },
      '★',
    ),
  );
  const paint = (n: number): void => buttons.forEach((b, i) => b.classList.toggle('on', i < n));
  row.append(...buttons);
  box.append(label, row, hint);
  // 전에 남긴 평점이 있으면 보여 준다
  myRating(track.id, account.id)
    .then((score) => {
      if (score > 0 && current === 0) {
        current = score;
        paint(score);
        hint.textContent = `전에 ${score}점을 남겼습니다. 다시 눌러 고칠 수 있습니다.`;
      }
    })
    .catch(() => undefined);
  return box;
}

// ── 올리기 ──────────────────────────────────────────────────────────────────

export function showUploadDialog(options: {
  title: string;
  /** 이미 올린 코스를 덮어쓰는지 */
  update: boolean;
  thumbnail: Blob | null;
  onSubmit: (title: string, isPublic: boolean) => Promise<void>;
}): void {
  const title = el('input', { class: 'text-input', type: 'text', maxLength: 60, value: options.title }) as HTMLInputElement;
  const pub = el('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const submit = el('button', { class: 'btn primary' }, options.update ? '다시 올리기' : '올리기') as HTMLButtonElement;
  const preview = el('div', { class: 'upload-preview' });
  if (options.thumbnail) {
    const url = URL.createObjectURL(options.thumbnail);
    const img = el('img', { src: url, alt: '썸네일 미리보기' });
    img.addEventListener('load', () => URL.revokeObjectURL(url));
    preview.append(img);
  } else {
    preview.append(el('div', { class: 'thumb-empty' }, '화면을 캡처하지 못했습니다'));
  }
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    submit.textContent = '올리는 중…';
    try {
      await options.onSubmit(title.value, pub.checked);
      close();
    } catch {
      submit.disabled = false;
      submit.textContent = options.update ? '다시 올리기' : '올리기';
    }
  });
  const close = openModal(
    [
      el('h1', {}, options.update ? '코스 다시 올리기' : '코스 올리기'),
      el(
        'p',
        {},
        options.update
          ? '전에 올린 코스를 지금 설계로 덮어씁니다. 설계가 바뀌면 그 코스의 최고 스릴 점수는 초기화됩니다.'
          : '지금 화면이 썸네일로 함께 올라갑니다. 마음에 드는 각도로 돌려 놓고 올려 보세요.',
      ),
      preview,
      el('label', { class: 'form-row' }, el('span', {}, '제목'), title),
      el('label', { class: 'check' }, pub, el('span', {}, '공개 ', el('small', {}, '끄면 나만 볼 수 있습니다'))),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close() }, '취소'), submit),
    ],
    { onDismiss: () => close() },
  );
  title.select();
}

// ── 계정 ────────────────────────────────────────────────────────────────────

export function showAccountDialog(session: Session, notify: Notify): void {
  const account = session.account;
  if (!account) return;

  const run = async (button: HTMLButtonElement, action: () => Promise<void>, done: string): Promise<void> => {
    button.disabled = true;
    try {
      await action();
      if (done) notify(done);
    } catch (err) {
      notify(describeError(err), 'error');
    }
    button.disabled = false;
  };

  const nick = el('input', { class: 'text-input', type: 'text', maxLength: NICKNAME_MAX, value: account.nickname }) as HTMLInputElement;
  const saveNick = el('button', { class: 'btn primary' }, '저장') as HTMLButtonElement;
  saveNick.addEventListener('click', () => void run(saveNick, () => session.setNickname(nick.value), '닉네임을 바꿨습니다'));
  nick.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveNick.click();
  });

  const sections: HTMLElement[] = [
    el('h1', {}, '계정'),
    el(
      'p',
      {},
      account.anonymous
        ? '지금은 이 브라우저에만 있는 익명 계정입니다. 브라우저 데이터를 지우면 올린 코스를 고칠 수 없게 되니, 계정을 연결해 두세요.'
        : `${account.email ?? '연결된 계정'} 으로 로그인되어 있습니다.`,
    ),
    el('label', { class: 'form-row' }, el('span', {}, '닉네임'), nick, saveNick),
  ];

  const email = el('input', { class: 'text-input', type: 'email', placeholder: 'name@example.com', autocomplete: 'email' }) as HTMLInputElement;
  const needEmail = (): string => {
    const v = email.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(v)) throw new Error('이메일 주소를 확인해 주세요');
    return v;
  };

  if (account.anonymous) {
    const linkMail = el('button', { class: 'btn' }, '이메일 연결') as HTMLButtonElement;
    linkMail.addEventListener('click', () =>
      void run(linkMail, async () => session.linkEmail(needEmail()), '확인 메일을 보냈습니다. 메일의 링크를 누르면 연결됩니다.'),
    );
    const linkGoogle = el('button', { class: 'btn' }, '구글 계정 연결') as HTMLButtonElement;
    linkGoogle.addEventListener('click', () => void run(linkGoogle, () => session.linkGoogle(), ''));
    const loginMail = el('button', { class: 'btn small' }, '이메일로 로그인') as HTMLButtonElement;
    loginMail.addEventListener('click', () =>
      void run(loginMail, async () => session.loginWithEmail(needEmail()), '로그인 링크를 메일로 보냈습니다.'),
    );
    const loginGoogle = el('button', { class: 'btn small' }, '구글로 로그인') as HTMLButtonElement;
    loginGoogle.addEventListener('click', () => void run(loginGoogle, () => session.loginWithGoogle(), ''));
    sections.push(
      el('h2', { class: 'modal-sub' }, '계정 연결'),
      el('p', { class: 'small-text' }, '지금 계정(올린 코스·평점·기록)을 그대로 둔 채 로그인 수단만 붙입니다.'),
      el('label', { class: 'form-row' }, el('span', {}, '이메일'), email, linkMail),
      el('div', { class: 'row' }, linkGoogle),
      el('h2', { class: 'modal-sub' }, '기존 계정으로 로그인'),
      el('p', { class: 'small-text' }, '다른 기기에서 만든 계정이 있을 때. 위 칸에 이메일을 적거나 구글을 고르세요. 지금의 익명 계정에서는 빠져나옵니다.'),
      el('div', { class: 'row' }, loginMail, loginGoogle),
    );
  } else {
    const out = el('button', { class: 'btn danger' }, '로그아웃') as HTMLButtonElement;
    out.addEventListener('click', () =>
      void run(out, async () => {
        await session.signOut();
        close();
      }, '로그아웃했습니다. 새 익명 계정으로 시작합니다.'),
    );
    sections.push(el('div', { class: 'row' }, out));
  }

  sections.push(el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close() }, '닫기')));
  const close = openModal(sections, { onDismiss: () => close() });
}
