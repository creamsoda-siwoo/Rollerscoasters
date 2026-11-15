import type { User } from '@supabase/supabase-js';
import { supabase } from './client';

/**
 * 로그인 상태. 처음 들어오면 익명 계정으로 바로 시작하고,
 * 나중에 이메일·구글을 "연결"하면 같은 계정(같은 id)이 정식 계정이 된다.
 */

export interface Account {
  id: string;
  nickname: string;
  /** 아직 이메일·구글을 연결하지 않은 익명 계정인지 */
  anonymous: boolean;
  email: string | null;
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
  if (/already (been )?registered|already linked|identity_already_exists|email_exists/i.test(msg))
    return '이미 다른 계정에 쓰이고 있습니다. "기존 계정으로 로그인"을 이용하세요';
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
      if (res.error) throw res.error;
      user = res.data.user;
    }
    return user ? this.load(user) : null;
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
      anonymous: user.is_anonymous === true,
      email: user.email ?? null,
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

  /** 익명 계정에 이메일을 연결한다. 확인 메일의 링크를 누르면 완료된다. */
  async linkEmail(email: string): Promise<void> {
    await this.ensure();
    const { error } = await supabase!.auth.updateUser({ email: email.trim() }, { emailRedirectTo: redirectUrl() });
    if (error) throw error;
  }

  /** 익명 계정에 구글 계정을 연결한다(구글로 이동했다가 돌아온다) */
  async linkGoogle(): Promise<void> {
    await this.ensure();
    const { error } = await supabase!.auth.linkIdentity({ provider: 'google', options: { redirectTo: redirectUrl() } });
    if (error) throw error;
  }

  /** 이미 만든 계정으로 로그인(다른 기기 등). 지금의 익명 계정에서는 빠져나온다. */
  async loginWithEmail(email: string): Promise<void> {
    const { error } = await supabase!.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: redirectUrl() },
    });
    if (error) throw error;
  }

  async loginWithGoogle(): Promise<void> {
    const { error } = await supabase!.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectUrl() } });
    if (error) throw error;
  }

  /** 로그아웃하고 새 익명 계정으로 다시 시작한다 */
  async signOut(): Promise<void> {
    await supabase!.auth.signOut();
    this.account = null;
    await this.ensure();
  }
}
