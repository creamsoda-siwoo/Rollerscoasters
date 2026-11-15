-- 손님 계정 → 이메일 계정으로 넘겨받기
--
-- 익명 로그인이 꺼진 프로젝트에서는 "손님 계정"(메일이 가지 않는 주소로 만든 계정)으로 시작하는데,
-- 그런 계정은 이메일 주소를 바꿀 수 없다. 대신 새 이메일 계정을 만들고, 손님 계정의
-- 코스·평점·기록을 그 계정으로 옮긴다.
--
-- 절차: (1) 손님 계정이 일회용 코드를 등록 → (2) 새 계정이 그 코드를 제시하고 넘겨받음.
-- 코드를 아는 사람만 넘겨받을 수 있으므로, 남의 계정을 가져가거나 남에게 떠넘길 수 없다.

create table public.account_claims (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  code_hash  text not null,
  expires_at timestamptz not null default now() + interval '10 minutes'
);

-- API 로는 아무도 직접 읽거나 쓸 수 없다(아래 함수만 접근)
alter table public.account_claims enable row level security;
revoke all on public.account_claims from anon, authenticated;

create function public.start_account_claim(p_code text) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다';
  end if;
  if char_length(p_code) < 32 then
    raise exception '코드가 너무 짧습니다';
  end if;
  insert into public.account_claims (user_id, code_hash)
  values (auth.uid(), encode(sha256(convert_to(p_code, 'UTF8')), 'hex'))
  on conflict (user_id) do update
    set code_hash = excluded.code_hash, expires_at = now() + interval '10 minutes';
end $$;

create function public.claim_account(p_from uuid, p_code text) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null or me = p_from then
    raise exception '넘겨받을 수 없는 계정입니다';
  end if;
  if not exists (
    select 1 from public.account_claims c
    where c.user_id = p_from
      and c.expires_at > now()
      and c.code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex')
  ) then
    raise exception '넘겨받기 코드가 맞지 않거나 만료되었습니다';
  end if;

  update public.tracks set user_id = me where user_id = p_from;

  -- 옮기면 규칙에 어긋나는 평점(자기 코스 평점, 한 코스에 두 번)은 버린다
  delete from public.ratings r
  where r.user_id in (p_from, me)
    and exists (select 1 from public.tracks t where t.id = r.track_id and t.user_id = me);
  delete from public.ratings r
  where r.user_id = p_from
    and exists (select 1 from public.ratings x where x.track_id = r.track_id and x.user_id = me);
  update public.ratings set user_id = me where user_id = p_from;

  update public.ride_records set user_id = me where user_id = p_from;

  update public.profiles p
  set nickname = (select g.nickname from public.profiles g where g.id = p_from)
  where p.id = me;

  delete from public.account_claims where user_id = p_from;
end $$;

revoke all on function public.start_account_claim(text) from public, anon;
revoke all on function public.claim_account(uuid, text) from public, anon;
grant execute on function public.start_account_claim(text) to authenticated;
grant execute on function public.claim_account(uuid, text) to authenticated;
