/** 표시용 숫자 서식 */

export function kmh(mps: number): string {
  return (mps * 3.6).toFixed(0);
}

export function fixed(value: number, digits = 1): string {
  // -0.0 처럼 보이는 것을 막는다
  const s = value.toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s;
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}초`;
  const m = Math.floor(seconds / 60);
  return `${m}분 ${Math.round(seconds - m * 60)}초`;
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
