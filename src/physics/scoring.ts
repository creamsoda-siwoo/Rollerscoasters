import type { RideRecord } from '../track/types';

/** G 한계. 이 범위를 벗어난 시간은 감점되고 화면 가장자리가 붉어진다. */
export const G_LIMITS = {
  /** 수직 G 상한 */
  vertMax: 5.5,
  /** 수직 G 하한 */
  vertMin: -2,
  /** 횡 G 상한(절댓값) */
  lateral: 2.2,
} as const;

/** 수직 G 가 이 값보다 작으면 에어타임으로 센다 */
export const AIRTIME_G = 0.2;

export type ThrillInput = Omit<RideRecord, 'thrill' | 'recordedAt'>;

/**
 * 스릴 점수.
 * 속도·G·에어타임·낙차·인버전이 클수록 오르고, 사람이 버티기 힘든 G 가 지속되면 깎인다.
 * 완주하지 못하면 0점.
 */
export function computeThrill(r: ThrillInput): number {
  if (!r.completed) return 0;
  const kmh = r.maxSpeed * 3.6;
  const speed = Math.min(kmh, 160) * 1.5;
  const gForce = Math.min(Math.max(r.maxG - 1, 0), 4) * 45;
  const air = Math.min(r.airtime, 8) * 30;
  const drop = Math.min(r.maxDrop, 80) * 2.5;
  const inversion = Math.min(r.inversions, 8) * 55;
  const lateral = Math.min(r.maxLateralG, 1.5) * 30;
  const duration = Math.min(r.rideTime, 120) * 0.5;
  const penalty = r.overGTime * 60;
  return Math.max(0, Math.round(speed + gForce + air + drop + inversion + lateral + duration - penalty));
}

export interface ThrillGrade {
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  label: string;
}

export function thrillGrade(score: number): ThrillGrade {
  if (score >= 700) return { grade: 'S', label: '극한의 스릴' };
  if (score >= 520) return { grade: 'A', label: '스릴 만점' };
  if (score >= 360) return { grade: 'B', label: '짜릿한 편' };
  if (score >= 200) return { grade: 'C', label: '가족용' };
  return { grade: 'D', label: '순한 맛' };
}
