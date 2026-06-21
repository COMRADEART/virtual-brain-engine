/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FEATURE_HYBRID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
