import { BANK_LIMIT, COURSE_VERSION, MIN_POINTS } from './types';
import type { ControlPoint, CourseData, RideRecord } from './types';

/** 짧은 무작위 ID */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function makePoint(x: number, y: number, z: number, bank = 0, chain = false): ControlPoint {
  return { id: uid(), x, y, z, bank, chain };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function cloneCourse(course: CourseData): CourseData {
  return JSON.parse(JSON.stringify(course)) as CourseData;
}

// ── 직렬화 ───────────────────────────────────────────────────────────────────

/**
 * 코스 전체를 JSON 문자열 하나로 만든다.
 * 좌표는 mm 단위로 반올림해 크기를 줄인다. 서버 저장 시에도 이 문자열을 그대로 쓴다.
 */
export function serializeCourse(course: CourseData, pretty = false): string {
  const out: CourseData = {
    version: COURSE_VERSION,
    id: course.id,
    name: course.name,
    createdAt: course.createdAt,
    updatedAt: course.updatedAt,
    points: course.points.map((p) => ({
      id: p.id,
      x: round(p.x, 3),
      y: round(p.y, 3),
      z: round(p.z, 3),
      bank: round(p.bank, 2),
      chain: p.chain,
    })),
    record: course.record,
  };
  if (course.remoteId) out.remoteId = course.remoteId;
  return JSON.stringify(out, null, pretty ? 2 : undefined);
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} 값이 숫자가 아닙니다`);
  return v;
}

function optNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function parseRecord(v: unknown): RideRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.completed !== 'boolean') return null;
  return {
    completed: r.completed,
    rideTime: optNum(r.rideTime, 0),
    maxSpeed: optNum(r.maxSpeed, 0),
    avgSpeed: optNum(r.avgSpeed, 0),
    maxG: optNum(r.maxG, 1),
    minG: optNum(r.minG, 1),
    maxLateralG: optNum(r.maxLateralG, 0),
    airtime: optNum(r.airtime, 0),
    inversions: optNum(r.inversions, 0),
    maxDrop: optNum(r.maxDrop, 0),
    maxHeight: optNum(r.maxHeight, 0),
    trackLength: optNum(r.trackLength, 0),
    overGTime: optNum(r.overGTime, 0),
    thrill: optNum(r.thrill, 0),
    stallAt: typeof r.stallAt === 'number' ? r.stallAt : null,
    recordedAt: typeof r.recordedAt === 'string' ? r.recordedAt : new Date().toISOString(),
  };
}

/**
 * JSON 문자열(또는 이미 파싱된 값)을 검증해 CourseData 로 만든다.
 * 형식이 잘못되면 사람이 읽을 수 있는 메시지로 Error 를 던진다.
 */
export function deserializeCourse(input: string | unknown): CourseData {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new Error('JSON 형식이 올바르지 않습니다');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('코스 데이터가 아닙니다');
  const o = raw as Record<string, unknown>;
  const version = optNum(o.version, NaN);
  if (!Number.isFinite(version)) throw new Error('version 이 없습니다');
  if (version > COURSE_VERSION) throw new Error(`지원하지 않는 코스 버전입니다 (v${version})`);
  if (!Array.isArray(o.points)) throw new Error('points 배열이 없습니다');
  if (o.points.length < MIN_POINTS) throw new Error(`제어점이 ${MIN_POINTS}개 이상 필요합니다`);
  if (o.points.length > 2000) throw new Error('제어점이 너무 많습니다');

  const seen = new Set<string>();
  const points: ControlPoint[] = o.points.map((pv, i) => {
    if (!pv || typeof pv !== 'object') throw new Error(`points[${i}] 가 올바르지 않습니다`);
    const p = pv as Record<string, unknown>;
    let id = typeof p.id === 'string' && p.id ? p.id : uid();
    while (seen.has(id)) id = uid();
    seen.add(id);
    const bank = optNum(p.bank, 0);
    return {
      id,
      x: num(p.x, `points[${i}].x`),
      y: num(p.y, `points[${i}].y`),
      z: num(p.z, `points[${i}].z`),
      bank: Math.max(-BANK_LIMIT, Math.min(BANK_LIMIT, bank)),
      chain: p.chain === true,
    };
  });

  const now = new Date().toISOString();
  return {
    version: COURSE_VERSION,
    id: typeof o.id === 'string' && o.id ? o.id : uid(),
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : '이름 없는 코스',
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : now,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : now,
    points,
    record: parseRecord(o.record),
    ...(typeof o.remoteId === 'string' && /^[0-9a-f-]{36}$/i.test(o.remoteId) ? { remoteId: o.remoteId } : {}),
  };
}

// ── 기본 제공 코스 ───────────────────────────────────────────────────────────

function newCourse(name: string, points: ControlPoint[]): CourseData {
  const now = new Date().toISOString();
  return { version: COURSE_VERSION, id: uid(), name, createdAt: now, updatedAt: now, points, record: null };
}

type Row = [x: number, y: number, z: number, bank?: number, chain?: boolean];

function fromRows(rows: Row[]): ControlPoint[] {
  return rows.map(([x, y, z, bank, chain]) => makePoint(x, y, z, bank ?? 0, chain ?? false));
}

/** "새 코스" 용: 리프트 하나와 낙하, 완만한 회전으로 이루어진 작은 순환 코스 */
export function createStarterCourse(): CourseData {
  return newCourse(
    '새 코스',
    fromRows([
      [-50, 3, 40],
      [-30, 3, 40, 0, true],
      [-16, 7, 40, 0, true],
      [22, 26, 40, 0, true],
      [36, 28, 39],
      [56, 10, 30, 0],
      [66, 4, 8, -40],
      [52, 6, -18, -45],
      [20, 9, -26, -10],
      [-10, 5, -28, 0],
      [-44, 6, -22, -30],
      [-66, 5, 0, -40],
      [-66, 3.5, 26, -25],
    ]),
  );
}

/** 처음 실행할 때 보여 주는 시연용 코스: 리프트 → 급하강 → 루프 → 에어타임 언덕 → 뱅크 턴 */
export function createDefaultCourse(): CourseData {
  return newCourse('첫 번째 코스', fromRows(DEFAULT_ROWS));
}

const DEFAULT_ROWS: Row[] = [
  // 승강장
  [-96, 3.2, 70],
  // 체인 리프트
  [-74, 3.2, 70, 0, true],
  [-58, 7.5, 70, 0, true],
  [-8, 37, 70, 0, true],
  // 정상 → 첫 낙하
  [8, 40, 70],
  [24, 35, 69, 8],
  [46, 8, 66, -8],
  // 바닥에서 왼쪽으로 크게 돌며 다시 오른다
  [70, 3.5, 54, -36],
  [88, 9, 30, -49],
  [86, 17, 2, -75],
  [65, 14.5, -19, -30],
  [45, 6.4, -23.6, -6],
  // 수직 루프
  [26, 4.5, -24],
  [16.3, 7.1, -24.5],
  [10.2, 13, -24.8],
  [8.6, 18.8, -24.9],
  [9.6, 22.8, -24.9],
  [11.7, 25, -25.2],
  [14.4, 25.7, -25.7],
  [17.1, 25, -26.2],
  [19.3, 22.8, -26.5],
  [20.3, 18.8, -26.6],
  [18.6, 13, -26.6],
  [12.6, 7.1, -26.9],
  [2.8, 4.5, -27.4],
  // 에어타임 언덕
  [-22, 5, -28],
  [-48, 13.5, -28],
  [-74, 5.6, -28],
  // 코르크스크류
  [-88, 5, -28],
  [-93.8, 6.2, -27.7, -26],
  [-98.7, 9.2, -26, -63],
  [-102.2, 12.2, -22.2, -114],
  [-104.7, 13.4, -17, -180],
  [-107.2, 12.2, -11.8, 114],
  [-110.7, 9.2, -8, 66],
  [-115.6, 6.2, -6.2, 31],
  [-121.4, 5, -6, -11],
  // 승강장으로 돌아오는 뱅크 턴
  [-145.4, 5.5, -2, -56],
  [-162.4, 6.5, 20, -47],
  [-161.4, 5, 48, -41],
  [-144.4, 3.8, 67, -48],
  [-120, 3.3, 70],
];
