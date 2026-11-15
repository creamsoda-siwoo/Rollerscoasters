function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * 지면 높이(m). 건설 구역 안쪽은 완만한 굴곡만 있고, 바깥으로 갈수록 언덕이 솟는다.
 * 지형 메쉬·지지대·편집기 모두 이 함수 하나를 기준으로 한다.
 * (three 에 의존하지 않아 테스트에서도 바로 쓸 수 있다.)
 */
export function terrainHeight(x: number, z: number): number {
  const n1 = Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.013 - 0.7);
  const n2 = Math.sin(x * 0.027 + z * 0.021 + 0.5);
  const n3 = Math.sin(x * 0.006 - z * 0.008 + 2.1);
  const mask = smoothstep(240, 560, Math.hypot(x, z));
  return n1 * 0.7 + n2 * 0.25 + mask * (30 + 16 * n3 + 12 * n1 + 6 * n2);
}
