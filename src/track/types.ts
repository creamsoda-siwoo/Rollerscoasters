/**
 * 코스 데이터 스키마.
 *
 * CourseData 하나가 코스 전체(설계 + 기록)를 담는 JSON 이다.
 * 다음 단계에서 서버에 그대로 저장/전송할 수 있도록 순수 JSON 값만 사용한다.
 */

/** 스키마 버전. 구조가 바뀌면 올리고 course.ts 의 deserializeCourse 에서 마이그레이션한다. */
export const COURSE_VERSION = 1;

/** 닫힌 루프를 만들기 위한 최소 제어점 수 */
export const MIN_POINTS = 3;

/** 제어점 뱅킹 허용 범위(도) */
export const BANK_LIMIT = 180;

export interface ControlPoint {
  id: string;
  /** 월드 좌표(m). y 가 위쪽. */
  x: number;
  y: number;
  z: number;
  /** 뱅킹(도). + 는 진행 방향 기준 오른쪽으로 기울임. 이웃 점 사이는 최단 경로로 보간된다. */
  bank: number;
  /** 이 점 → 다음 점 구간이 체인 리프트인지 */
  chain: boolean;
}

/** 탑승 1회의 결과 */
export interface RideRecord {
  /** 한 바퀴를 완주했는지 */
  completed: boolean;
  /** 탑승 시간(초) */
  rideTime: number;
  /** 최고 속도(m/s) */
  maxSpeed: number;
  /** 평균 속도(m/s) */
  avgSpeed: number;
  /** 최대 수직 G */
  maxG: number;
  /** 최소 수직 G (음수면 에어타임) */
  minG: number;
  /** 최대 횡 G (절댓값) */
  maxLateralG: number;
  /** 무중력에 가까운 시간(초) */
  airtime: number;
  /** 인버전(뒤집힘) 횟수 */
  inversions: number;
  /** 최대 낙차(m) */
  maxDrop: number;
  /** 최고 높이(m, 지면 기준이 아닌 절대 y) */
  maxHeight: number;
  /** 트랙 길이(m) */
  trackLength: number;
  /** 과도한 G 를 받은 시간(초) */
  overGTime: number;
  /** 스릴 점수 */
  thrill: number;
  /** 실패 시 멈춘 위치(출발점부터의 거리 m), 완주 시 null */
  stallAt: number | null;
  /** ISO 시각 */
  recordedAt: string;
}

export interface CourseData {
  version: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 순서대로 이어지며 마지막 점은 첫 점으로 닫힌다. points[0] 이 출발(승강장) 지점. */
  points: ControlPoint[];
  /** 현재 설계에 대한 탑승 기록. 설계가 바뀌면 null 로 초기화된다. */
  record: RideRecord | null;
}
