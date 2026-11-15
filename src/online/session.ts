import type { User } from '@supabase/supabase-js';
import { supabase } from './client';

/**
 * 로그인 상태. 처음 들어오면 로그인 화면 없이 바로 시작하고,
 * 나중에 이메일을 "연결"하면 같은 계정(같은 id)이 정식 계정이 된다.
 *
 * 바로 시작하는 방법은 두 가지다.
 *  1. Supabase 익명 로그인(프로젝트에서 켜져 있을 때)
 *  2. 꺼져 있으면 "손님 계정": 이 브라우저만 아는 무작위 주소·비밀번호로 가입한다.
 *     주소는 메일이 가지 않는 예약 도메인(example.com)이라 실제 메일은 보내지지 않는다.
 *     프로젝트의 이메일 자동 확인(autoconfirm)이 켜져 있어야 동작한다.
 */

export interface Account {
  id: string;
  nickname: string;
  /** 아직 이메일을 연결하지 않은 손님(익명) 계정인지 */
  anonymous: boolean;
  email: string | null;
}

/** 손님 계정 주소. example.com 은 문서·테스트용 예약 도메인이라 누구의 메일함도 아니다. */
const GUEST_DOMAIN = 'coaster-guest.example.com';
const GUEST_KEY = 'coaster-studio/guest/v1';

function isGuestEmail(email: string | null | undefined): boolean {
  return !!email && email.endsWith(`@${GUEST_DOMAIN}`);
}

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 20;

type Listener = (account: Account | null) => void;

function redirectUrl(): string {
  return window.location.origin + window.location.pathname;
}

/** Supabase 오류를 사용자에게 보여 줄 문장으로 */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const msg = raw || (err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : '');
  if (/anonymous sign-?ins are disabled/i.test(msg)) return '서버에서 익명 로그인이 꺼져 있습니다';
  if (/manual linking is disabled/i.test(msg)) return '서버에서 계정 연결(manual linking)이 꺼져 있습니다';
  if (/provider is not enabled|unsupported provider/i.test(msg)) return '서버에서 이 로그인 방식이 꺼져 있습니다';
  if (/invalid login credentials/i.test(msg)) return '이메일 또는 비밀번호가 맞지 않습니다';
  if (/password should be|weak password/i.test(msg)) return '비밀번호는 6자 이상으로 정해 주세요';
  if (/signups? (are )?(not allowed|disabled)/i.test(msg)) return '서버에서 가입이 막혀 있습니다';
  if (/already (been )?registered|already linked|identity_already_exists|email_exists/i.test(msg))
    return '이미 다른 계정에 쓰이고 있습니다. "기존 계정으로 로그인"을 이용하세요';
  if (/could not find the function/i.test(msg)) return '서버에 이 기능이 아직 적용되지 않았습니다(마이그레이션 필요)';
  if (/rate limit|too many/i.test(msg)) return '요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요';
  if (/failed to fetch|network/i.test(msg)) return '서버에 연결하지 못했습니다';
  if (/row-level security|permission denied/i.test(msg)) return '권한이 없습니다';
  if (/10초/.test(msg)) return msg;
  return msg || '알 수 없는 오류';
}

export class Session {
  account: Account | null = null;
  private listeners: Listener[] = [];
  private starting: Promise<Account | null> | null = null;

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.account);
  }

  /** 세션을 되살리거나, 없으면 익명으로 로그인한다. 여러 번 불러도 한 번만 실행된다. */
  ensure(): Promise<Account | null> {
    if (!supabase) return Promise.resolve(null);
    if (this.account) return Promise.resolve(this.account);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<Account | null> {
    const sb = supabase!;
    sb.auth.onAuthStateChange((event, session) => {
      // 콜백 안에서 바로 다른 Supabase 호출을 하면 교착될 수 있어 한 박자 미룬다
      if (event === 'SIGNED_OUT') {
        this.account = null;
        this.emit();
      } else if (session?.user && (event === 'SIGNED_IN' || event === 'USER_UPDATED')) {
        window.setTimeout(() => void this.load(session.user), 0);
      }
    });
    const { data } = await sb.auth.getSession();
    let user = data.session?.user ?? null;
    if (!user) {
      const res = await sb.auth.signInAnonymously();
      if (!res.error) user = res.data.user;
      else if (/anonymous sign-?ins are disabled/i.test(res.error.message)) user = await this.guestSignIn();
      else throw res.error;
    }
    return user ? this.load(user) : null;
  }

  /** 익명 로그인이 꺼진 프로젝트용: 이 브라우저 전용 손님 계정으로 들어간다 */
  private async guestSignIn(): Promise<User | null> {
    const sb = supabase!;
    type Creds = { email: string; password: string };
    let saved: Creds | null;
    try {
      saved = JSON.parse(localStorage.getItem(GUEST_KEY) ?? 'null') as Creds | null;
    } catch {
      saved = null;
    }
    if (saved?.email && saved.password) {
      // 세션이 만료됐더라도 같은 손님 계정으로 다시 들어간다
      const res = await sb.auth.signInWithPassword(saved);
      if (!res.error) return res.data.user;
    }
    const creds = { email: `guest-${randomToken(10)}@${GUEST_DOMAIN}`, password: randomToken(24) };
    const res = await sb.auth.signUp(creds);
    if (res.error) throw res.error;
    if (!res.data.session) throw new Error('서버가 가입 확인 메일을 요구해 바로 시작할 수 없습니다');
    try {
      localStorage.setItem(GUEST_KEY, JSON.stringify(creds));
    } catch {
      // 저장하지 못해도 이번 세션은 쓸 수 있다
    }
    return res.data.user;
  }

  private async load(user: User): Promise<Account> {
    const sb = supabase!;
    let { data } = await sb.from('profiles').select('nickname').eq('id', user.id).maybeSingle();
    if (!data) {
      // 가입 트리거가 없던 시절의 계정 등: 직접 만든다
      const nickname = `라이더${user.id.replace(/-/g, '').slice(0, 5).toUpperCase()}`;
      await sb.from('profiles').insert({ id: user.id, nickname });
      data = { nickname };
    }
    this.account = {
      id: user.id,
      nickname: data.nickname as string,
      anonymous: user.is_anonymous === true || isGuestEmail(user.email),
      email: isGuestEmail(user.email) ? null : (user.email ?? null),
    };
    this.emit();
    return this.account;
  }

  async setNickname(nickname: string): Promise<void> {
    const value = nickname.trim();
    if (value.length < NICKNAME_MIN || value.length > NICKNAME_MAX) {
      throw new Error(`닉네임은 ${NICKNAME_MIN}~${NICKNAME_MAX}자로 정해 주세요`);
    }
    const account = await this.ensure();
    if (!account) throw new Error('로그인되어 있지 않습니다');
    const { error } = await supabase!.from('profiles').update({ nickname: value }).eq('id', account.id);
    if (error) throw error;
    this.account = { ...account, nickname: value };
    this.emit();
  }

  /**
   * 지금 계정에 이메일과 비밀번호를 붙여 정식 계정으로 만든다. 올린 코스·평점·기록은 유지된다.
   * 바로 적용되면 true, 확인 메일의 링크를 눌러야 하면 false.
   */
  async linkEmail(email: string, password: string): Promise<boolean> {
    const sb = supabase!;
    const account = await this.ensure();
    if (!account) throw new Error('로그인되어 있지 않습니다');
    const address = email.trim().toLowerCase();
    const { data: current } = await sb.auth.getUser();

    if (!isGuestEmail(current.user?.email)) {
      // Supabase 익명 계정: 같은 계정에 이메일을 그대로 붙일 수 있다
      const { data, error } = await sb.auth.updateUser({ email: address, password }, { emailRedirectTo: redirectUrl() });
      if (error) throw error;
      const done = data.user?.email?.toLowerCase() === address;
      if (done && data.user) await this.load(data.user);
      return done;
    }

    // 손님 계정은 주소를 바꿀 수 없으므로, 새 계정을 만들고 일회용 코드로 내용을 넘겨받는다
    const code = randomToken(24);
    const started = await sb.rpc('start_account_claim', { p_code: code });
    if (started.error) throw started.error;
    const signUp = await sb.auth.signUp({ email: address, password });
    if (signUp.error) throw signUp.error;
    // 이미 가입된 주소면 Supabase 는 오류 대신 세션 없는 응답을 준다
    if (!signUp.data.session || !signUp.data.user) {
      throw new Error('이 이메일로는 연결할 수 없습니다. 이미 가입된 주소라면 "기존 계정으로 로그인"을 이용하세요');
    }
    const claimed = await sb.rpc('claim_account', { p_from: account.id, p_code: code });
    try {
      localStorage.removeItem(GUEST_KEY);
    } catch {
      // 무시
    }
    await this.load(signUp.data.user);
    if (claimed.error) throw new Error(`계정은 만들었지만 코스를 옮기지 못했습니다: ${describeError(claimed.error)}`);
    return true;
  }

  /** 이미 만든 계정으로 로그인(다른 기기 등). 지금의 손님 계정에서는 빠져나온다. */
  async loginWithEmail(email: string, password: string): Promise<void> {
    const { data, error } = await supabase!.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) throw error;
    try {
      localStorage.removeItem(GUEST_KEY);
    } catch {
      // 무시
    }
    if (data.user) await this.load(data.user);
  }

  /** 로그아웃하고 새 익명 계정으로 다시 시작한다 */
  async signOut(): Promise<void> {
    await supabase!.auth.signOut({ scope: 'local' });
    this.account = null;
    await this.ensure();
  }
}
