# 배포 가이드 (Supabase + Vercel)

게임 자체는 정적 사이트입니다. 서버 쪽은 Supabase(인증·DB·Storage)가 전부 맡고,
브라우저는 **anon(publishable) 키**로만 접속합니다. 접근 제어는 DB 의 RLS 가 합니다.

환경변수가 없으면 온라인 기능만 꺼지고 게임은 그대로(로컬 저장) 동작합니다.

## 1. Supabase

1. **프로젝트 만들기** — 대시보드에서 새 프로젝트(한국이면 `ap-northeast-2` 서울).
2. **마이그레이션 적용** — 둘 중 하나.
   - SQL Editor 에 `supabase/migrations/20261115000000_online.sql` 전체를 붙여 실행
   - 또는 CLI: `supabase link --project-ref <ref>` → `supabase db push`
3. **익명 로그인 켜기** — Authentication → Sign In / Providers → *Allow anonymous sign-ins*.
4. **계정 연결 켜기** — 같은 화면의 *Allow manual linking*. (익명 계정에 구글을 붙이는 데 필요)
5. **이메일** — Email provider 사용, *Confirm email* 켜 둠.
   기본 내장 메일은 시간당 발송 수가 매우 적으니 실제 서비스 전에는 Custom SMTP 를 연결하세요.
6. **구글 로그인** — Google Cloud Console 에서 OAuth 클라이언트(웹)를 만들고
   - 승인된 리디렉션 URI: `https://<ref>.supabase.co/auth/v1/callback`
   - Client ID / Secret 을 Supabase 의 Google provider 에 입력
   (구글을 쓰지 않으면 건너뛰어도 됩니다. 버튼을 누르면 "꺼져 있습니다" 안내가 뜹니다.)
7. **URL 설정** — Authentication → URL Configuration
   - Site URL: 배포 주소 (예: `https://coaster.vercel.app`)
   - Redirect URLs: 배포 주소, `http://localhost:5173`, 필요하면 Vercel 미리보기 주소 패턴
8. **키 확인** — Project Settings → API 에서 Project URL 과 anon(publishable) 키를 복사.

## 2. Vercel

1. GitHub 저장소를 Vercel 프로젝트로 가져옵니다. `vercel.json` 이 빌드 설정을 잡아 줍니다
   (프레임워크 Vite, `npm run build`, 출력 `dist`).
2. Settings → Environment Variables 에 두 값을 넣습니다(Production·Preview 모두).

   | 이름 | 값 |
   | --- | --- |
   | `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | anon(publishable) 키 |

3. 배포합니다. 환경변수는 **빌드할 때** 코드에 박히므로, 값을 바꾸면 다시 배포해야 합니다.

로컬 개발은 `.env.example` 을 `.env.local` 로 복사해 같은 값을 넣으면 됩니다.

## 3. 키에 대한 주의

- `VITE_` 로 시작하는 환경변수는 브라우저로 그대로 내려갑니다. 누구나 볼 수 있는 값입니다.
- 그래서 여기에는 **anon/publishable 키만** 넣습니다. 이 키는 공개되어도 RLS 가 막아 줍니다.
- **service_role(secret) 키는 RLS 를 통째로 건너뜁니다. Vercel 환경변수에도, 코드에도, 저장소에도 넣지 마세요.**
  이 프로젝트에는 service role 키가 필요한 코드가 없습니다.
- 실수에 대비해 클라이언트가 키를 검사합니다. service role 키가 들어오면 온라인 기능을 끄고 콘솔에 경고를 냅니다
  (`src/online/client.ts`). 그런 일이 생겼다면 키는 이미 노출된 것이니 대시보드에서 즉시 교체하세요.

## 4. 배포 체크리스트

배포 전

- [ ] 마이그레이션 적용됨 — Table Editor 에 `profiles` `tracks` `ratings` `ride_records` 가 보이고 모두 RLS 켜짐
- [ ] Storage 에 `thumbnails` 버킷(공개, 512KB 제한)이 있음
- [ ] 익명 로그인 켜짐, manual linking 켜짐 (꺼져 있으면 오른쪽 위에 "접속 실패"가 뜸)
- [ ] Site URL / Redirect URLs 에 배포 주소가 들어 있음
- [ ] Vercel 환경변수 2개 설정, 값이 anon 키인지 다시 확인(service_role 아님)
- [ ] `npm run build` 와 `npm test` 통과
- [ ] (선택) `bash supabase/tests/run-local.sh` 로 RLS 검증 통과

배포 후 (실제 사이트에서)

- [ ] 처음 열면 오른쪽 위에 `라이더XXXXX` 닉네임이 뜬다(익명 로그인 성공)
- [ ] 계정 → 닉네임 변경이 저장된다
- [ ] 올리기 → 둘러보기 "내 코스"에 썸네일과 함께 보인다
- [ ] 다른 브라우저(시크릿 창)에서 그 코스가 보이고, 타 본 뒤 별점이 남는다
- [ ] 그 코스의 탑승 횟수·평점·스릴 점수가 올라가고 "스릴 리더보드"에 나타난다
- [ ] 다른 계정으로는 남의 코스에 삭제 버튼이 보이지 않는다
- [ ] 이메일 연결 → 확인 메일의 링크가 배포 주소로 돌아온다
- [ ] 구글 연결/로그인 후 배포 주소로 돌아온다
- [ ] Supabase 대시보드 Advisors(Security) 에 경고가 없다

운영하면서

- [ ] 익명 가입 남용 대비: Authentication → Attack Protection 에서 CAPTCHA(Turnstile 등) 검토
- [ ] 무료 플랜은 일정 기간 사용이 없으면 프로젝트가 일시 중지됨
- [ ] 오래된 익명 계정 정리(연결하지 않은 계정은 브라우저 데이터를 지우면 다시 들어갈 수 없음)

## 5. 데이터 모델

| 테이블 | 내용 | 읽기 | 쓰기 |
| --- | --- | --- | --- |
| `profiles` | id, nickname, created_at | 누구나 | 본인 닉네임만 |
| `tracks` | 코스 JSON(`data`), 썸네일, 집계 값 | 공개 코스는 누구나, 비공개는 작성자 | 작성자만 수정·삭제 |
| `ratings` | (track_id, user_id) 당 1~5점 하나 | 누구나 | 본인 것만, 자기 코스에는 불가 |
| `ride_records` | 최고 속도, 최대 G, 스릴 점수 | 누구나 | 본인 이름으로 추가만 |

- `tracks.play_count` `avg_rating` `rating_count` `best_thrill` 은 클라이언트에 쓰기 권한이 없고 트리거가 갱신합니다.
- 평점은 `rate_track(track_id, score)` RPC 로 남깁니다(있으면 고치고 없으면 만듦).
- 요청하신 컬럼 외에 `tracks.is_public`, `rating_count`, `best_thrill`, `updated_at` 을 더했습니다.
- 썸네일은 Storage `thumbnails/<사용자 id>/<코스 id>.jpg`. 자기 폴더에만 쓸 수 있습니다.

## 6. 알아 둘 한계

- **기록은 클라이언트가 보고한 값입니다.** 물리 계산이 브라우저에서 돌기 때문에, 요청을 조작하면
  가짜 스릴 점수를 넣을 수 있습니다. 지금은 범위 검사와 10초 간격 제한만 있습니다.
  순위가 중요해지면 Edge Function 에서 코스 JSON 으로 시뮬레이션을 다시 돌려 검증하는 방식이 필요합니다
  (`src/physics`, `src/track/spline.ts` 는 화면 없이 돌아가도록 만들어져 있습니다).
- 물리가 결정론적이라 같은 코스는 누가 타도 같은 점수가 나옵니다. 그래서 리더보드는
  "코스 안에서의 사람 순위"가 아니라 **코스끼리의 스릴 점수 순위**입니다.
