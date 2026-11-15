import { describe, expect, it } from 'vitest';
import { terrainHeight } from '../src/core/terrainHeight';
import { createDefaultCourse, createStarterCourse, deserializeCourse, makePoint, serializeCourse } from '../src/track/course';
import { buildPreset } from '../src/track/presets';
import { buildTrack, createFrame, wrapDeg } from '../src/track/spline';

const flat = () => 0;

describe('스플라인 트랙', () => {
  it('제어점을 지나는 닫힌 루프를 만든다', () => {
    const course = createDefaultCourse();
    const track = buildTrack(course.points);
    const f = createFrame();
    course.points.forEach((p, i) => {
      track.frameAt(track.pointS[i], f);
      expect(Math.hypot(f.pos.x - p.x, f.pos.y - p.y, f.pos.z - p.z)).toBeLessThan(0.3);
    });
    // 마지막 샘플과 첫 샘플 사이도 한 간격이어야 한다(닫힘)
    const n = track.count;
    const gap = Math.hypot(
      track.pos[0] - track.pos[(n - 1) * 3],
      track.pos[1] - track.pos[(n - 1) * 3 + 1],
      track.pos[2] - track.pos[(n - 1) * 3 + 2],
    );
    expect(gap).toBeLessThan(track.step * 1.2);
  });

  it('샘플이 호 길이 기준으로 고르게 놓인다', () => {
    const track = buildTrack(createDefaultCourse().points);
    for (let k = 0; k < track.count; k++) {
      const j = ((k + 1) % track.count) * 3;
      const d = Math.hypot(track.pos[j] - track.pos[k * 3], track.pos[j + 1] - track.pos[k * 3 + 1], track.pos[j + 2] - track.pos[k * 3 + 2]);
      expect(d).toBeGreaterThan(track.step * 0.9);
      expect(d).toBeLessThan(track.step * 1.1);
    }
  });

  it('프레임이 직교 정규이고 한 바퀴 뒤 이어진다', () => {
    for (const course of [createDefaultCourse(), createStarterCourse()]) {
      const track = buildTrack(course.points);
      const n = track.count;
      for (let k = 0; k < n; k++) {
        const o = k * 3;
        const dot = track.tan[o] * track.up[o] + track.tan[o + 1] * track.up[o + 1] + track.tan[o + 2] * track.up[o + 2];
        expect(Math.abs(dot)).toBeLessThan(1e-9);
        expect(Math.hypot(track.up[o], track.up[o + 1], track.up[o + 2])).toBeCloseTo(1, 9);
        // 이웃 샘플끼리 위쪽 축이 급격히 꺾이지 않는다
        const j = ((k + 1) % n) * 3;
        const cont = track.up[o] * track.up[j] + track.up[o + 1] * track.up[j + 1] + track.up[o + 2] * track.up[j + 2];
        expect(cont).toBeGreaterThan(0.9);
      }
    }
  });

  it('완만한 트랙은 뱅킹 0 에서 똑바로 선다', () => {
    const pts = createStarterCourse().points.map((p) => ({ ...p, bank: 0 }));
    const track = buildTrack(pts);
    for (let k = 0; k < track.count; k++) expect(track.up[k * 3 + 1]).toBeGreaterThan(0.5);
  });

  it('뱅킹 +90° 는 오른쪽이 아래로 내려간다', () => {
    const pts = [makePoint(0, 10, 0, 90), makePoint(100, 10, 0, 90), makePoint(100, 10, 100, 90), makePoint(0, 10, 100, 90)];
    const track = buildTrack(pts);
    for (let k = 0; k < track.count; k++) expect(track.right[k * 3 + 1]).toBeLessThan(-0.99);
  });

  it('wrapDeg 는 최단 각도 차를 준다', () => {
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-190)).toBe(170);
    expect(wrapDeg(45)).toBe(45);
  });
});

describe('프리셋 부품', () => {
  const lead = [makePoint(-80, 30, 0), makePoint(-60, 30, 0), makePoint(-40, 22, 0), makePoint(-15, 4, 0), makePoint(0, 3, 0)];
  const tail = (x: number, z: number) => [makePoint(x + 25, 3, z), makePoint(x + 70, 5, z + 10), makePoint(x + 90, 5, z + 60), makePoint(40, 8, 90), makePoint(-60, 20, 80), makePoint(-110, 30, 30)];

  it('루프는 꼭대기에서 뒤집히고 진입 높이로 돌아온다', () => {
    const res = buildPreset('loop', { origin: lead[4], heading: { x: 1, z: 0 }, groundAt: flat, bounds: 500 });
    if (!res.ok) throw new Error(res.error);
    const last = res.points[res.points.length - 1];
    expect(last.y).toBeCloseTo(3, 5);
    const track = buildTrack([...lead, ...res.points, ...tail(last.x, last.z)]);
    let minUp = 1;
    for (let k = 0; k < track.count; k++) minUp = Math.min(minUp, track.up[k * 3 + 1]);
    expect(minUp).toBeLessThan(-0.95);
    // 루프 뒤에는 다시 바로 선다
    const f = track.frameAt(track.pointS[4 + res.points.length] + 15, createFrame());
    expect(f.up.y).toBeGreaterThan(0.9);
  });

  it('코르크스크류는 한 바퀴 돌아 바로 선 채 나온다', () => {
    const res = buildPreset('corkscrew', { origin: lead[4], heading: { x: 1, z: 0 }, groundAt: flat, bounds: 500 });
    if (!res.ok) throw new Error(res.error);
    const last = res.points[res.points.length - 1];
    const track = buildTrack([...lead, ...res.points, ...tail(last.x, last.z)]);
    let minUp = 1;
    for (let k = 0; k < track.count; k++) minUp = Math.min(minUp, track.up[k * 3 + 1]);
    expect(minUp).toBeLessThan(-0.9);
    const f = track.frameAt(track.pointS[4 + res.points.length] + 12, createFrame());
    expect(f.up.y).toBeGreaterThan(0.9);
  });

  it('급하강은 높이가 모자라면 거절하고, 충분하면 지면 위에서 끝난다', () => {
    const low = buildPreset('drop', { origin: makePoint(0, 6, 0), heading: { x: 1, z: 0 }, groundAt: flat, bounds: 500 });
    expect(low.ok).toBe(false);
    const res = buildPreset('drop', { origin: makePoint(0, 40, 0), heading: { x: 0, z: 1 }, groundAt: terrainHeight, bounds: 500 });
    if (!res.ok) throw new Error(res.error);
    for (const p of res.points) expect(p.y).toBeGreaterThan(terrainHeight(p.x, p.z) + 1);
    expect(res.points[res.points.length - 1].y).toBeLessThan(6);
  });

  it('건설 구역을 벗어나면 거절한다', () => {
    const res = buildPreset('loop', { origin: makePoint(195, 5, 0), heading: { x: 1, z: 0 }, groundAt: flat, bounds: 200 });
    expect(res.ok).toBe(false);
  });
});

describe('코스 JSON', () => {
  it('직렬화 → 역직렬화가 같은 코스를 돌려준다', () => {
    const course = createDefaultCourse();
    const json = serializeCourse(course);
    const back = deserializeCourse(json);
    expect(back.points.length).toBe(course.points.length);
    expect(back.name).toBe(course.name);
    expect(back.id).toBe(course.id);
    back.points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(course.points[i].x, 3);
      expect(p.y).toBeCloseTo(course.points[i].y, 3);
      expect(p.z).toBeCloseTo(course.points[i].z, 3);
      expect(p.bank).toBe(course.points[i].bank);
      expect(p.chain).toBe(course.points[i].chain);
    });
    // 한 번 더 돌려도 문자열이 같다(안정적)
    expect(serializeCourse(back)).toBe(json);
  });

  it('잘못된 입력은 읽을 수 있는 오류로 거절한다', () => {
    expect(() => deserializeCourse('{nope')).toThrow(/JSON/);
    expect(() => deserializeCourse('[]')).toThrow();
    expect(() => deserializeCourse({ version: 1, points: [] })).toThrow(/제어점/);
    expect(() => deserializeCourse({ version: 99, points: [] })).toThrow(/버전/);
    expect(() => deserializeCourse({ version: 1, points: [{ x: 'a', y: 0, z: 0 }, {}, {}] })).toThrow(/숫자/);
  });

  it('빠진 값은 기본값으로 채우고 중복 id 를 고친다', () => {
    const c = deserializeCourse({
      version: 1,
      points: [
        { id: 'a', x: 0, y: 5, z: 0 },
        { id: 'a', x: 10, y: 5, z: 0, bank: 999, chain: true },
        { x: 10, y: 5, z: 10 },
      ],
    });
    expect(new Set(c.points.map((p) => p.id)).size).toBe(3);
    expect(c.points[1].bank).toBe(180);
    expect(c.points[1].chain).toBe(true);
    expect(c.points[0].chain).toBe(false);
    expect(c.record).toBeNull();
    expect(c.name).toBeTruthy();
  });
});
