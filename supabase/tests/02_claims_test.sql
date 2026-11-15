-- 손님 계정 넘겨받기 검증
do $$
declare
  g uuid := '00000000-0000-0000-0000-0000000000c1';  -- 손님
  n uuid := '00000000-0000-0000-0000-0000000000c2';  -- 새 이메일 계정
  x uuid := '00000000-0000-0000-0000-0000000000c3';  -- 제3자
  tg uuid := '33333333-3333-3333-3333-333333333333'; -- 손님의 코스
  tx uuid := '44444444-4444-4444-4444-444444444444'; -- 제3자의 코스
  code text := 'abcdefghijklmnopqrstuvwxyz0123456789abcdef';
  course text := '{"version":1,"points":[{"x":0,"y":1,"z":0},{"x":1,"y":1,"z":0},{"x":1,"y":1,"z":1}]}';
  v text;
begin
  insert into auth.users (id) values (g), (n), (x);
  perform t.run(g, format('update public.profiles set nickname = ''손님닉'' where id = %L', g));
  perform t.run(g, format('insert into public.tracks (id, title, data) values (%L, ''손님 코스'', %L)', tg, course));
  perform t.run(x, format('insert into public.tracks (id, title, data) values (%L, ''남의 코스'', %L)', tx, course));
  perform t.run(g, format('select public.rate_track(%L, 3)', tx));
  perform t.run(g, format('insert into public.ride_records (track_id, max_speed, max_g, thrill_score) values (%L, 10, 2, 300)', tx));
  perform t.run(x, format('select public.rate_track(%L, 5)', tg));

  perform t.expect('claims 테이블 직접 읽기 불가', t.run(g, 'select 1 from public.account_claims'), 'err:%permission denied%');
  perform t.expect('anon 은 코드 등록 불가', t.run(null, format('select public.start_account_claim(%L)', code)), 'err:%permission denied%');
  perform t.expect('짧은 코드 거절', t.run(g, 'select public.start_account_claim(''short'')'), 'err:%짧습니다%');
  perform t.expect('코드 없이는 넘겨받기 불가', t.run(n, format('select public.claim_account(%L, %L)', g, code)), 'err:%맞지 않거나%');
  perform t.expect('손님이 코드 등록', t.run(g, format('select public.start_account_claim(%L)', code)), 'ok:1');
  perform t.expect('틀린 코드 거절', t.run(n, format('select public.claim_account(%L, %L)', g, code || 'x')), 'err:%맞지 않거나%');
  perform t.expect('자기 자신은 불가', t.run(g, format('select public.claim_account(%L, %L)', g, code)), 'err:%넘겨받을 수 없는%');
  perform t.expect('코드 없는 남의 계정은 불가', t.run(n, format('select public.claim_account(%L, %L)', x, code)), 'err:%맞지 않거나%');
  perform t.expect('맞는 코드로 넘겨받기', t.run(n, format('select public.claim_account(%L, %L)', g, code)), 'ok:1');

  select user_id::text into v from public.tracks where id = tg;
  perform t.expect('코스 소유자가 새 계정', v, n::text);
  select count(*)::text into v from public.ratings where track_id = tx and user_id = n;
  perform t.expect('남의 코스에 남긴 평점이 따라옴', v, '1');
  select avg_rating || '/' || rating_count into v from public.tracks where id = tg;
  perform t.expect('받은 평점은 그대로', v, '5.00/1');
  select count(*)::text into v from public.ride_records where user_id = n;
  perform t.expect('기록이 따라옴', v, '1');
  select nickname into v from public.profiles where id = n;
  perform t.expect('닉네임이 따라옴', v, '손님닉');
  perform t.expect('코드는 한 번만 쓸 수 있음', t.run(x, format('select public.claim_account(%L, %L)', g, code)), 'err:%맞지 않거나%');
  perform t.expect('새 계정이 코스 수정 가능', t.run(n, format('update public.tracks set title = ''내 코스'' where id = %L', tg)), 'ok:1');
  perform t.expect('옛 손님은 더 이상 수정 불가', t.run(g, format('update public.tracks set title = ''x'' where id = %L', tg)), 'ok:0');

  -- 만료된 코드
  perform t.run(x, format('select public.start_account_claim(%L)', code));
  update public.account_claims set expires_at = now() - interval '1 minute' where user_id = x;
  perform t.expect('만료된 코드 거절', t.run(n, format('select public.claim_account(%L, %L)', x, code)), 'err:%맞지 않거나%');
end $$;

do $$
declare n int;
begin
  select count(*) into n from t.fail;
  if n > 0 then raise exception '% 개 실패', n; end if;
end $$;
