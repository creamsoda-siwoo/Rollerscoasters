import { deserializeCourse, serializeCourse } from './course';
import type { CourseData, RideRecord } from './types';

/**
 * localStorage 저장소.
 *
 * 저장 단위는 serializeCourse() 가 만든 코스 JSON 그대로다.
 * 다음 단계에서 서버 저장으로 바꿀 때는 이 파일의 함수들만 API 호출로 교체하면 된다.
 */

const SLOTS_KEY = 'coaster-studio/courses/v1';
const AUTOSAVE_KEY = 'coaster-studio/autosave/v1';

export interface CourseSummary {
  id: string;
  name: string;
  updatedAt: string;
  pointCount: number;
  record: RideRecord | null;
}

function readSlots(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SLOTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeSlots(slots: Record<string, unknown>): void {
  localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
}

/** 저장된 코스 목록 (최근 수정 순) */
export function listCourses(): CourseSummary[] {
  const out: CourseSummary[] = [];
  for (const value of Object.values(readSlots())) {
    try {
      const c = deserializeCourse(value);
      out.push({ id: c.id, name: c.name, updatedAt: c.updatedAt, pointCount: c.points.length, record: c.record });
    } catch {
      // 손상된 항목은 건너뛴다
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 코스를 id 슬롯에 저장(덮어쓰기). 실패하면 Error 를 던진다. */
export function saveCourse(course: CourseData): void {
  const slots = readSlots();
  slots[course.id] = JSON.parse(serializeCourse(course));
  try {
    writeSlots(slots);
  } catch {
    throw new Error('저장 공간이 부족하거나 저장이 차단되어 있습니다');
  }
}

export function loadCourse(id: string): CourseData | null {
  const value = readSlots()[id];
  if (!value) return null;
  try {
    return deserializeCourse(value);
  } catch {
    return null;
  }
}

export function deleteCourse(id: string): void {
  const slots = readSlots();
  delete slots[id];
  try {
    writeSlots(slots);
  } catch {
    // 무시
  }
}

/** 작업 중인 코스를 자동 저장한다(새로고침 대비). 실패해도 조용히 넘어간다. */
export function saveAutosave(course: CourseData): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serializeCourse(course));
  } catch {
    // 무시
  }
}

export function loadAutosave(): CourseData | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? deserializeCourse(raw) : null;
  } catch {
    return null;
  }
}
