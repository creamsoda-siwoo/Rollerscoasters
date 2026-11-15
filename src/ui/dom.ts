/** id 로 요소를 찾는다. 없으면 바로 실패시켜 마크업과 코드가 어긋난 것을 빨리 알아챈다. */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 요소가 없습니다`);
  return el as T;
}

type Child = Node | string | null | undefined | false;

/** 간단한 요소 생성기: el('div', { class: 'x', onclick }, 자식...) */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (key in node) {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** 입력란에 포커스가 있으면 단축키를 가로채지 않기 위한 검사 */
export function isTyping(): boolean {
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'TEXTAREA' || (tag === 'INPUT' && (a as HTMLInputElement).type !== 'range' && (a as HTMLInputElement).type !== 'checkbox');
}
