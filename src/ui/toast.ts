import { $, el } from './dom';

/** 화면 아래에 잠깐 떴다 사라지는 알림 */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const root = $('toasts');
  const node = el('div', { class: `toast ${kind === 'error' ? 'error' : ''}` }, message);
  root.append(node);
  while (root.children.length > 3) root.firstElementChild?.remove();
  window.setTimeout(() => node.classList.add('out'), kind === 'error' ? 3400 : 2400);
  window.setTimeout(() => node.remove(), kind === 'error' ? 3800 : 2800);
}
