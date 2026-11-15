import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase 클라이언트. 환경변수가 없으면 null 이고, 그때 게임은 오프라인(로컬 저장)으로만 동작한다.
 *
 * 브라우저에는 anon(publishable) 키만 둔다. 이 키는 공개되어도 되는 값이며
 * 실제 접근 제어는 DB 의 RLS 가 한다. service role 키는 RLS 를 건너뛰므로 여기에 오면 안 된다.
 */

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/** 실수로 관리자 키를 넣었는지 검사한다 */
export function isPrivilegedKey(k: string): boolean {
  if (k.startsWith('sb_secret_')) return true;
  const parts = k.split('.');
  if (parts.length !== 3) return false;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { role?: string }).role === 'service_role';
  } catch {
    return false;
  }
}

function create(): SupabaseClient | null {
  if (!url || !key) return null;
  if (isPrivilegedKey(key)) {
    console.error(
      '[coaster] VITE_SUPABASE_ANON_KEY 에 service role(secret) 키가 들어 있습니다. ' +
        '이 키는 브라우저에 노출되면 안 됩니다. 온라인 기능을 끄고, 키를 즉시 교체(rotate)하세요.',
    );
    return null;
  }
  return createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

export const supabase = create();
export const onlineEnabled = supabase !== null;
/** 온라인 기능을 쓸 수 없을 때 보여 줄 안내 */
export const OFFLINE_MESSAGE =
  key && isPrivilegedKey(key)
    ? '서버 키 설정이 잘못되어 온라인 기능이 꺼져 있습니다'
    : '온라인 기능이 설정되지 않았습니다 (Supabase 환경변수 필요)';
