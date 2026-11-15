/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase 프로젝트 URL */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon(publishable) 키. service role 키는 절대 넣지 않는다. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
