import type { VaultState } from './api';

export type TabId = 'runs' | 'clusters' | 'compare' | 'recipes' | 'minimize';

export interface AppProps {
  state: VaultState;
  refresh: () => Promise<void>;
  notify: (message: string, isError?: boolean) => void;
}

export const PACK_VERSIONS = [1, 2] as const;
