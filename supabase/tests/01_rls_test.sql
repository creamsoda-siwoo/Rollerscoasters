-- RLS·트리거 동작 검증. 실패가 하나라도 있으면 마지막에 예외로 끝난다.
create schema t;
create table t.fail (label text);
grant usage on schema t to anon, authenticated;

-- uid 사용자로(널이면 anon) SQL 을 실행하고 'ok:<행수>' 또는 'err:<메시지>' 를 돌려준다
create function t.run(uid uuid, q text) returns text language plpgsql as $$
declare n bigint; res text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  if uid is null then set local role anon; else set local role authenticated; end if;
  begin
    execute q;
    get diagnostics n = row_count;
    res := 'ok:' || n;
  exception when others then
    res := 'err:' || sqlerrm;
  end;
  reset role;
  return res;
end $$;

create function t.expect(label text, actual text, want text) returns void language plpgsql as $$
begin
  if actual like want then raise notice 'PASS  %', label;
  else raise notice 'FAIL  % — got [%], want [%]', label, actual, want; insert into t.fail values (label);
  end if;
end $$;

do $$
declare
  a uuid := '00000000-0000-0000-0000-00000000000a';
  b uuid := '00000000-0000-0000-0000-00000000000b';
  ta uuid := '11111111-1111-1111-1111-111111111111';
  tp uuid := '22222222-2222-2222-2222-222222222222';
  course text := '{"version":1,"points":[{"x":0,"y":1,"z":0},{"x":1,"y":1,"z":0},{"x":1,"y":1,"z":1}]}';
  v text;
begin
  -- 가입 → 프로필 자동 생성
  insert into auth.users (id) values (a), (b);
  select count(*)::text into v from public.profiles;
  perform t.expect('가입하면 프로필이 생긴다', v, '2');

  -- 닉네임
  perform t.expect('본인 닉네임 수정', t.run(a, format('update public.profiles set nickname = ''에이'' where id = %L', a)), 'ok:1');
  perform t.expect('남의 닉네임은 못 고침', t.run(a, format('update public.profiles set nickname = ''해킹'' where id = %L', b)), 'ok:0');
  perform t.expect('닉네임 길이 제한', t.run(a, format('update public.profiles set nickname = ''a'' where id = %L', a)), 'err:%');
  perform t.expect('anon 은 프로필 수정 불가', t.run(null, 'update public.profiles set nickname = ''익명''' ), 'err:%permission denied%');

  -- 코스 등록
  perform t.expect('본인 코스 등록', t.run(a, format('insert into public.tracks (id, title, data) values (%L, ''A코스'', %L)', ta, course)), 'ok:1');
  perform t.expect('비공개 코스 등록', t.run(a, format('insert into public.tracks (id, title, data, is_public) values (%L, ''비공개'', %L, false)', tp, course)), 'ok:1');
  perform t.expect('남의 이름으로 등록 불가', t.run(b, format('insert into public.tracks (user_id, title, data) values (%L, ''사칭'', %L)', a, course)), 'err:%row-level security%');
  perform t.expect('anon 은 등록 불가', t.run(null, format('insert into public.tracks (title, data) values (''x'', %L)', course)), 'err:%permission denied%');
  perform t.expect('엉터리 data 거절', t.run(a, 'insert into public.tracks (title, data) values (''x'', ''{"points":[]}'')'), 'err:%check constraint%');
  perform t.expect('집계 값을 넣어 등록 불가', t.run(a, format('insert into public.tracks (title, data, play_count) values (''x'', %L, 999)', course)), 'err:%permission denied%');

  -- 읽기
  perform t.expect('anon 은 공개 코스만 본다', t.run(null, 'select 1 from public.tracks'), 'ok:1');
  perform t.expect('남은 공개 코스만 본다', t.run(b, 'select 1 from public.tracks'), 'ok:1');
  perform t.expect('작성자는 비공개도 본다', t.run(a, 'select 1 from public.tracks'), 'ok:2');

  -- 수정/삭제
  perform t.expect('작성자 제목 수정', t.run(a, format('update public.tracks set title = ''새 제목'' where id = %L', ta)), 'ok:1');
  perform t.expect('남은 수정 불가', t.run(b, format('update public.tracks set title = ''해킹'' where id = %L', ta)), 'ok:0');
  perform t.expect('작성자도 play_count 직접 수정 불가', t.run(a, format('update public.tracks set play_count = 999 where id = %L', ta)), 'err:%permission denied%');
  perform t.expect('작성자도 avg_rating 직접 수정 불가', t.run(a, format('update public.tracks set avg_rating = 5 where id = %L', ta)), 'err:%permission denied%');
  perform t.expect('소유권 넘기기 불가', t.run(a, format('update public.tracks set user_id = %L where id = %L', b, ta)), 'err:%permission denied%');
  perform t.expect('남은 삭제 불가', t.run(b, format('delete from public.tracks where id = %L', ta)), 'ok:0');

  -- 평점
  perform t.expect('남의 코스에 평점', t.run(b, format('select public.rate_track(%L, 4)', ta)), 'ok:1');
  select avg_rating || '/' || rating_count into v from public.tracks where id = ta;
  perform t.expect('평균 4.00, 1개', v, '4.00/1');
  perform t.expect('평점 고치기(중복 행 없이)', t.run(b, format('select public.rate_track(%L, 2)', ta)), 'ok:1');
  select avg_rating || '/' || rating_count into v from public.tracks where id = ta;
  perform t.expect('평균 2.00, 여전히 1개', v, '2.00/1');
  perform t.expect('직접 insert 로 중복 평점 불가', t.run(b, format('insert into public.ratings (track_id, score) values (%L, 5)', ta)), 'err:%duplicate key%');
  perform t.expect('자기 코스 자평 불가', t.run(a, format('select public.rate_track(%L, 5)', ta)), 'err:%row-level security%');
  perform t.expect('범위 밖 점수 거절', t.run(b, format('select public.rate_track(%L, 6)', ta)), 'err:%check constraint%');
  perform t.expect('남의 이름으로 평점 불가', t.run(b, format('insert into public.ratings (track_id, user_id, score) values (%L, %L, 5)', ta, a)), 'err:%row-level security%');
  perform t.expect('볼 수 없는 비공개 코스엔 평점 불가', t.run(b, format('select public.rate_track(%L, 5)', tp)), 'err:%row-level security%');
  perform t.expect('anon 은 평점 불가', t.run(null, format('select public.rate_track(%L, 5)', ta)), 'err:%permission denied%');
  perform t.expect('남의 평점 수정 불가', t.run(a, format('update public.ratings set score = 5 where track_id = %L', ta)), 'ok:0');
  perform t.expect('본인 평점 삭제', t.run(b, format('delete from public.ratings where track_id = %L', ta)), 'ok:1');
  select avg_rating || '/' || rating_count into v from public.tracks where id = ta;
  perform t.expect('삭제 후 평균 0, 0개', v, '0.00/0');

  -- 탑승 기록
  perform t.expect('본인 기록 작성', t.run(b, format('insert into public.ride_records (track_id, max_speed, max_g, thrill_score) values (%L, 26.4, 4.5, 619)', ta)), 'ok:1');
  select play_count || '/' || best_thrill into v from public.tracks where id = ta;
  perform t.expect('탑승 1회, 최고 스릴 619', v, '1/619');
  perform t.expect('연달아 등록은 막힘', t.run(b, format('insert into public.ride_records (track_id, max_speed, max_g, thrill_score) values (%L, 26.4, 4.5, 619)', ta)), 'err:%10초%');
  perform t.expect('다른 사람은 등록 가능', t.run(a, format('insert into public.ride_records (track_id, max_speed, max_g, thrill_score) values (%L, 20, 3, 500)', ta)), 'ok:1');
  select play_count || '/' || best_thrill into v from public.tracks where id = ta;
  perform t.expect('탑승 2회, 최고 스릴 유지', v, '2/619');
  perform t.expect('남의 이름으로 기록 불가', t.run(b, format('insert into public.ride_records (track_id, user_id, max_speed, max_g, thrill_score) values (%L, %L, 1, 1, 1)', tp, a)), 'err:%row-level security%');
  perform t.expect('볼 수 없는 코스엔 기록 불가', t.run(b, format('insert into public.ride_records (track_id, max_speed, max_g, thrill_score) values (%L, 1, 1, 1)', tp)), 'err:%row-level security%');
  perform t.expect('말이 안 되는 점수 거절', t.run(b, format('insert into public.ride_records (track_id, max_speed, max_g, thrill_score) values (%L, 1, 1, 999999)', tp)), 'err:%');
  perform t.expect('기록 수정 불가', t.run(b, 'update public.ride_records set thrill_score = 3000'), 'err:%permission denied%');
  perform t.expect('기록 삭제 불가', t.run(b, 'delete from public.ride_records'), 'err:%permission denied%');
  perform t.expect('anon 은 기록 불가', t.run(null, format('insert into public.ride_records (track_id, max_speed, max_g, thrill_score) values (%L, 1, 1, 1)', ta)), 'err:%permission denied%');
  perform t.expect('anon 도 기록 읽기', t.run(null, 'select 1 from public.ride_records'), 'ok:2');

  -- 설계를 바꾸면 최고 스릴 초기화
  perform t.run(a, format('update public.tracks set data = %L where id = %L', replace(course, '"y":1', '"y":2'), ta));
  select best_thrill::text into v from public.tracks where id = ta;
  perform t.expect('설계 변경 시 best_thrill 초기화', v, '0');

  -- 썸네일 저장소
  perform t.expect('자기 폴더에 업로드', t.run(a, format('insert into storage.objects (bucket_id, name) values (''thumbnails'', %L)', a || '/x.jpg')), 'ok:1');
  perform t.expect('남의 폴더에 업로드 불가', t.run(b, format('insert into storage.objects (bucket_id, name) values (''thumbnails'', %L)', a || '/y.jpg')), 'err:%row-level security%');
  perform t.expect('남의 파일 삭제 불가', t.run(b, 'delete from storage.objects'), 'ok:0');
  perform t.expect('anon 업로드 불가', t.run(null, 'insert into storage.objects (bucket_id, name) values (''thumbnails'', ''z/z.jpg'')'), 'err:%');

  -- 작성자 삭제 → 평점·기록도 함께 삭제
  perform t.expect('작성자 삭제', t.run(a, format('delete from public.tracks where id = %L', ta)), 'ok:1');
  select count(*)::text into v from public.ride_records;
  perform t.expect('기록도 함께 삭제', v, '0');

  -- 계정 삭제 → 프로필·코스 삭제
  delete from auth.users where id = a;
  select (select count(*) from public.profiles) || '/' || (select count(*) from public.tracks) into v;
  perform t.expect('계정 삭제 시 프로필·코스 정리', v, '1/0');
end $$;

do $$
declare n int;
begin
  select count(*) into n from t.fail;
  if n > 0 then raise exception '% 개 실패', n; end if;
  raise notice '모든 검증 통과';
end $$;
