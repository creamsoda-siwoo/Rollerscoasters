import { describe, expect, it } from 'vitest';
import { isPrivilegedKey } from '../src/online/client';
import { createDefaultCourse, deserializeCourse, serializeCourse } from '../src/track/course';

const jwt = (payload: object) =>
  `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.signature`;

describe('Supabase 키 검사', () => {
  it('service role / secret 키를 알아챈다', () => {
    expect(isPrivilegedKey(jwt({ role: 'service_role', iss: 'supabase' }))).toBe(true);
    expect(isPrivilegedKey('sb_secret_abcdef')).toBe(true);
  });
  it('anon / publishable 키는 통과시킨다', () => {
    expect(isPrivilegedKey(jwt({ role: 'anon', iss: 'supabase' }))).toBe(false);
    expect(isPrivilegedKey('sb_publishable_abcdef')).toBe(false);
    expect(isPrivilegedKey('not-a-jwt')).toBe(false);
  });
});

describe('코스의 서버 연결 정보', () => {
  it('remoteId 는 직렬화를 거쳐도 유지되고, 이상한 값은 버린다', () => {
    const course = createDefaultCourse();
    expect(JSON.parse(serializeCourse(course)).remoteId).toBeUndefined();
    course.remoteId = '3f2b8c1e-1234-4abc-9def-0123456789ab';
    expect(deserializeCourse(serializeCourse(course)).remoteId).toBe(course.remoteId);
    const raw = JSON.parse(serializeCourse(course));
    raw.remoteId = '"; drop table tracks; --';
    expect(deserializeCourse(raw).remoteId).toBeUndefined();
  });
});
