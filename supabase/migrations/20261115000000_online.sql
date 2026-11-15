-- 코스터 스튜디오 온라인 기능: 프로필, 코스 공유, 평점, 탑승 기록, 썸네일 저장소
--
-- 원칙
--  * 클라이언트는 anon(publishable) 키만 쓴다. 모든 접근 제어는 RLS 와 컬럼 권한으로 한다.
--  * 집계 값(play_count, avg_rating, rating_count, best_thrill)은 클라이언트가 직접 쓸 수 없고
--    트리거만 갱신한다.

-- ───────────────────────────── profiles ─────────────────────────────

create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  nickname   text not null check (char_length(btrim(nickname)) between 2 and 20),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: 누구나 읽기" on public.profiles
  for select to anon, authenticated using (true);

create policy "profiles: 본인만 생성" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));

create policy "profiles: 본인만 수정" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant insert (id, nickname) on public.profiles to authenticated;
grant update (nickname) on public.profiles to authenticated;

-- 가입(익명 로그인 포함)하면 프로필을 자동으로 만든다
create function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, '라이더' || upper(substr(replace(new.id::text, '-', ''), 1, 5)))
  on conflict (id) do nothing;
  return new;
exception when others then
  -- 프로필 생성이 실패해도 가입 자체는 막지 않는다(클라이언트가 처음 접속할 때 다시 만든다)
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────────── tracks ─────────────────────────────

create table public.tracks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title         text not null check (char_length(btrim(title)) between 1 and 60),
  -- 클라이언트의 코스 JSON(CourseData) 그대로
  data          jsonb not null check (
                  jsonb_typeof(data) = 'object'
                  and jsonb_typeof(data -> 'points') = 'array'
                  and jsonb_array_length(data -> 'points') between 3 and 2000
                  and pg_column_size(data) < 400000
                ),
  thumbnail_url text check (thumbnail_url is null or char_length(thumbnail_url) < 600),
  is_public     boolean not null default true,
  play_count    integer not null default 0,
  avg_rating    numeric(3, 2) not null default 0,
  rating_count  integer not null default 0,
  best_thrill   integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index tracks_user_idx on public.tracks (user_id);
create index tracks_popular_idx on public.tracks (play_count desc, created_at desc) where is_public;
create index tracks_recent_idx on public.tracks (created_at desc) where is_public;
create index tracks_rating_idx on public.tracks (avg_rating desc, rating_count desc) where is_public;
create index tracks_thrill_idx on public.tracks (best_thrill desc) where is_public;

alter table public.tracks enable row level security;

create policy "tracks: 공개 또는 본인 것만 읽기" on public.tracks
  for select to anon, authenticated
  using (is_public or user_id = (select auth.uid()));

create policy "tracks: 본인 이름으로만 등록" on public.tracks
  for insert to authenticated with check (user_id = (select auth.uid()));

create policy "tracks: 작성자만 수정" on public.tracks
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "tracks: 작성자만 삭제" on public.tracks
  for delete to authenticated using (user_id = (select auth.uid()));

-- 집계 컬럼은 권한 자체를 주지 않는다
revoke all on public.tracks from anon, authenticated;
grant select on public.tracks to anon, authenticated;
grant insert (id, user_id, title, data, thumbnail_url, is_public) on public.tracks to authenticated;
grant update (title, data, thumbnail_url, is_public) on public.tracks to authenticated;
grant delete on public.tracks to authenticated;

create function public.touch_track() returns trigger
  language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  -- 설계가 바뀌면 이전 설계로 얻은 스릴 점수는 무효
  if new.data is distinct from old.data then
    new.best_thrill := 0;
  end if;
  return new;
end $$;

create trigger tracks_touch
  before update of title, data, thumbnail_url, is_public on public.tracks
  for each row execute function public.touch_track();

-- ───────────────────────────── ratings ─────────────────────────────

create table public.ratings (
  track_id   uuid not null references public.tracks (id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  score      smallint not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 한 사람이 한 코스에 평점 하나: unique (track_id, user_id)
  primary key (track_id, user_id)
);

alter table public.ratings enable row level security;

create policy "ratings: 누구나 읽기" on public.ratings
  for select to anon, authenticated using (true);

-- 볼 수 있는 남의 코스에만 평점을 남길 수 있다(자기 코스 자평 금지)
create policy "ratings: 본인 평점만 작성" on public.ratings
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.tracks t
      where t.id = track_id and t.user_id <> (select auth.uid())
    )
  );

create policy "ratings: 본인 평점만 수정" on public.ratings
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "ratings: 본인 평점만 삭제" on public.ratings
  for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.ratings from anon, authenticated;
grant select on public.ratings to anon, authenticated;
grant insert (track_id, user_id, score) on public.ratings to authenticated;
grant update (score, updated_at) on public.ratings to authenticated;
grant delete on public.ratings to authenticated;

-- 평점이 바뀔 때마다 코스의 평균·개수를 다시 계산
create function public.refresh_track_rating() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  target uuid := coalesce(new.track_id, old.track_id);
begin
  update public.tracks t
  set avg_rating = coalesce((select round(avg(r.score), 2) from public.ratings r where r.track_id = target), 0),
      rating_count = (select count(*) from public.ratings r where r.track_id = target)
  where t.id = target;
  return null;
end $$;

create trigger ratings_refresh
  after insert or update of score or delete on public.ratings
  for each row execute function public.refresh_track_rating();

-- 평점 남기기/고치기. 호출자 권한으로 실행되므로 RLS 가 그대로 적용된다.
create function public.rate_track(p_track_id uuid, p_score integer) returns void
  language sql security invoker set search_path = '' as $$
  insert into public.ratings (track_id, user_id, score)
  values (p_track_id, auth.uid(), p_score)
  on conflict (track_id, user_id)
  do update set score = excluded.score, updated_at = now();
$$;

revoke all on function public.rate_track(uuid, integer) from public, anon;
grant execute on function public.rate_track(uuid, integer) to authenticated;

-- ───────────────────────────── ride_records ─────────────────────────────

create table public.ride_records (
  id           bigint generated always as identity primary key,
  track_id     uuid not null references public.tracks (id) on delete cascade,
  user_id      uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  max_speed    real not null check (max_speed between 0 and 150),      -- m/s
  max_g        real not null check (max_g between -20 and 60),
  thrill_score integer not null check (thrill_score between 0 and 3000),
  created_at   timestamptz not null default now()
);

create index ride_records_track_idx on public.ride_records (track_id, thrill_score desc);
create index ride_records_user_idx on public.ride_records (user_id, track_id, created_at desc);

alter table public.ride_records enable row level security;

create policy "ride_records: 누구나 읽기" on public.ride_records
  for select to anon, authenticated using (true);

create policy "ride_records: 본인 기록만 작성" on public.ride_records
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.tracks t where t.id = track_id)
  );

-- 기록은 고치거나 지울 수 없다(코스·계정이 지워지면 함께 사라짐)
revoke all on public.ride_records from anon, authenticated;
grant select on public.ride_records to anon, authenticated;
grant insert (track_id, user_id, max_speed, max_g, thrill_score) on public.ride_records to authenticated;

-- 같은 코스를 연달아 등록해 탑승 횟수를 부풀리는 것을 막는다
create function public.guard_ride_record() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.ride_records r
    where r.user_id = new.user_id and r.track_id = new.track_id
      and r.created_at > now() - interval '10 seconds'
  ) then
    raise exception '기록은 10초에 한 번만 남길 수 있습니다' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger ride_records_guard
  before insert on public.ride_records
  for each row execute function public.guard_ride_record();

-- 탑승 기록이 쌓일 때 탑승 횟수와 최고 스릴 점수를 갱신
create function public.apply_ride_record() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  update public.tracks t
  set play_count = t.play_count + 1,
      best_thrill = greatest(t.best_thrill, new.thrill_score)
  where t.id = new.track_id;
  return null;
end $$;

create trigger ride_records_apply
  after insert on public.ride_records
  for each row execute function public.apply_ride_record();

-- 트리거 함수는 API 로 직접 부를 일이 없다
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.touch_track() from public, anon, authenticated;
revoke all on function public.refresh_track_rating() from public, anon, authenticated;
revoke all on function public.guard_ride_record() from public, anon, authenticated;
revoke all on function public.apply_ride_record() from public, anon, authenticated;

-- ───────────────────────────── 썸네일 저장소 ─────────────────────────────
-- 공개 버킷: 파일 URL 을 아는 사람은 누구나 볼 수 있다. 쓰기는 자기 폴더(<uid>/...)에만.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('thumbnails', 'thumbnails', true, 524288, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "thumbnails: 자기 폴더 조회" on storage.objects
  for select to authenticated
  using (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "thumbnails: 자기 폴더에만 올리기" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "thumbnails: 자기 파일만 덮어쓰기" on storage.objects
  for update to authenticated
  using (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "thumbnails: 자기 파일만 삭제" on storage.objects
  for delete to authenticated
  using (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text);
