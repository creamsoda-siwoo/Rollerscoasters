import { deserializeCourse, serializeCourse } from '../track/course';
import type { CourseData, RideRecord } from '../track/types';
import { supabase } from './client';

/** 둘러보기 목록의 코스 한 줄 */
export interface TrackRow {
  id: string;
  user_id: string;
  title: string;
  thumbnail_url: string | null;
  is_public: boolean;
  play_count: number;
  avg_rating: number;
  rating_count: number;
  best_thrill: number;
  created_at: string;
  /** 작성자 닉네임 */
  author: string;
}

export type TrackSort = 'popular' | 'recent' | 'rating' | 'thrill' | 'mine';

export const PAGE_SIZE = 24;

const LIST_COLUMNS =
  'id, user_id, title, thumbnail_url, is_public, play_count, avg_rating, rating_count, best_thrill, created_at, profiles!tracks_user_id_fkey(nickname)';

function db() {
  if (!supabase) throw new Error('온라인 기능이 설정되지 않았습니다');
  return supabase;
}

function toRow(r: Record<string, unknown>): TrackRow {
  const profile = r.profiles as { nickname?: string } | { nickname?: string }[] | null;
  const nickname = Array.isArray(profile) ? profile[0]?.nickname : profile?.nickname;
  return {
    id: String(r.id),
    user_id: String(r.user_id),
    title: String(r.title),
    thumbnail_url: (r.thumbnail_url as string | null) ?? null,
    is_public: r.is_public !== false,
    play_count: Number(r.play_count) || 0,
    avg_rating: Number(r.avg_rating) || 0,
    rating_count: Number(r.rating_count) || 0,
    best_thrill: Number(r.best_thrill) || 0,
    created_at: String(r.created_at),
    author: nickname || '이름 없음',
  };
}

/** 코스 목록. mine 은 내 코스(비공개 포함), 나머지는 공개 코스. */
export async function listTracks(sort: TrackSort, page: number, userId: string | null): Promise<TrackRow[]> {
  let q = db().from('tracks').select(LIST_COLUMNS);
  if (sort === 'mine') {
    if (!userId) return [];
    q = q.eq('user_id', userId).order('created_at', { ascending: false });
  } else {
    q = q.eq('is_public', true);
    if (sort === 'popular') q = q.order('play_count', { ascending: false });
    else if (sort === 'rating') q = q.order('avg_rating', { ascending: false }).order('rating_count', { ascending: false });
    else if (sort === 'thrill') q = q.gt('best_thrill', 0).order('best_thrill', { ascending: false });
    q = q.order('created_at', { ascending: false });
  }
  const from = page * PAGE_SIZE;
  const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
  if (error) throw error;
  return (data ?? []).map((r) => toRow(r as Record<string, unknown>));
}

/** 코스 설계 데이터를 받아 검증한다(남이 올린 JSON 이므로 그대로 믿지 않는다) */
export async function fetchCourse(trackId: string): Promise<CourseData> {
  const { data, error } = await db().from('tracks').select('title, data').eq('id', trackId).single();
  if (error) throw error;
  const course = deserializeCourse(data.data);
  course.name = String(data.title);
  course.record = null;
  delete course.remoteId;
  return course;
}

export interface UploadInput {
  course: CourseData;
  title: string;
  isPublic: boolean;
  thumbnail: Blob | null;
  userId: string;
}

/**
 * 코스를 올린다. 이미 내가 올린 코스(course.remoteId)면 덮어쓰고, 아니면 새로 만든다.
 * 썸네일은 Storage 의 thumbnails/<내 id>/<코스 id>.jpg 에 둔다.
 */
export async function uploadTrack(input: UploadInput): Promise<string> {
  const sb = db();
  const { course, userId } = input;
  const title = input.title.trim().slice(0, 60) || '이름 없는 코스';
  // 서버에는 설계만 올린다(개인 기록·연결 정보 제외)
  const clean: CourseData = { ...course, name: title, record: null };
  delete clean.remoteId;
  const data = JSON.parse(serializeCourse(clean)) as unknown;

  let id = course.remoteId ?? null;
  if (id) {
    // 내 것이 아직 남아 있는지 확인(삭제했거나 남의 코스를 복사한 경우 새로 만든다)
    const { data: mine } = await sb.from('tracks').select('id').eq('id', id).eq('user_id', userId).maybeSingle();
    if (!mine) id = null;
  }
  const isNew = !id;
  id ??= crypto.randomUUID();

  let thumbnailUrl: string | null | undefined;
  if (input.thumbnail) {
    const path = `${userId}/${id}.jpg`;
    const up = await sb.storage.from('thumbnails').upload(path, input.thumbnail, {
      contentType: 'image/jpeg',
      upsert: true,
      cacheControl: '3600',
    });
    if (!up.error) {
      // 같은 경로를 덮어쓰므로 주소에 버전을 붙여 캐시를 피한다
      thumbnailUrl = `${sb.storage.from('thumbnails').getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
    }
  }

  if (isNew) {
    const { error } = await sb
      .from('tracks')
      .insert({ id, user_id: userId, title, data, thumbnail_url: thumbnailUrl ?? null, is_public: input.isPublic });
    if (error) throw error;
  } else {
    const patch: Record<string, unknown> = { title, data, is_public: input.isPublic };
    if (thumbnailUrl) patch.thumbnail_url = thumbnailUrl;
    const { error } = await sb.from('tracks').update(patch).eq('id', id);
    if (error) throw error;
  }
  return id;
}

export async function deleteTrack(track: TrackRow): Promise<void> {
  const sb = db();
  const { error } = await sb.from('tracks').delete().eq('id', track.id);
  if (error) throw error;
  // 썸네일 정리는 실패해도 무시한다
  await sb.storage.from('thumbnails').remove([`${track.user_id}/${track.id}.jpg`]);
}

/** 내가 이 코스에 남긴 평점. 없으면 0 */
export async function myRating(trackId: string, userId: string): Promise<number> {
  const { data, error } = await db()
    .from('ratings')
    .select('score')
    .eq('track_id', trackId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.score) : 0;
}

export async function rateTrack(trackId: string, score: number): Promise<void> {
  const { error } = await db().rpc('rate_track', { p_track_id: trackId, p_score: score });
  if (error) throw error;
}

/** 완주 기록을 남긴다. 탑승 횟수와 코스의 최고 스릴 점수는 서버 트리거가 갱신한다. */
export async function submitRecord(trackId: string, userId: string, record: RideRecord): Promise<void> {
  const { error } = await db()
    .from('ride_records')
    .insert({
      track_id: trackId,
      user_id: userId,
      max_speed: Number(record.maxSpeed.toFixed(2)),
      max_g: Number(record.maxG.toFixed(2)),
      thrill_score: Math.round(record.thrill),
    });
  if (error) throw error;
}
