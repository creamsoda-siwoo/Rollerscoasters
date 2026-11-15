/**
 * 스냅샷 방식 실행취소/다시실행.
 * 상태를 JSON 문자열로 쌓아 두므로 어떤 편집이든 같은 방식으로 되돌릴 수 있다.
 */
export class History<T> {
  private stack: string[] = [];
  private index = -1;

  constructor(private readonly limit = 200) {}

  /** 기록을 비우고 현재 상태를 기준점으로 삼는다 */
  reset(state: T): void {
    this.stack = [JSON.stringify(state)];
    this.index = 0;
  }

  /** 편집이 끝난 뒤의 상태를 쌓는다. 직전과 같으면 무시하고 false 를 돌려준다. */
  push(state: T): boolean {
    const json = JSON.stringify(state);
    if (this.index >= 0 && this.stack[this.index] === json) return false;
    this.stack.length = this.index + 1;
    this.stack.push(json);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    return true;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.stack.length - 1;
  }

  undo(): T | null {
    if (!this.canUndo) return null;
    return JSON.parse(this.stack[--this.index]) as T;
  }

  redo(): T | null {
    if (!this.canRedo) return null;
    return JSON.parse(this.stack[++this.index]) as T;
  }
}
