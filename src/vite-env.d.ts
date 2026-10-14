/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_ORIGIN?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_APP_BASE?: string;
  readonly VITE_APP_ROUTER?: 'browser' | 'hash';
  readonly VITE_DISABLE_PWA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
