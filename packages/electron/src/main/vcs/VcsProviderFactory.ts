import { existsSync } from 'fs';
import { join } from 'path';
import type { VcsType } from './types';
import type { VcsProvider } from './VcsProvider';
import { GitProvider } from './providers/GitProvider';
import { JjProvider } from './providers/JjProvider';

const providerCache = new Map<string, VcsProvider>();

export function detectVcsType(workspacePath: string): VcsType | null {
  if (existsSync(join(workspacePath, '.jj'))) {
    return 'jj';
  }
  if (existsSync(join(workspacePath, '.git'))) {
    return 'git';
  }
  return null;
}

export function getVcsProvider(workspacePath: string): VcsProvider | null {
  const cached = providerCache.get(workspacePath);
  if (cached) {
    // Re-validate: if .jj was added/removed, the cached provider type may be stale
    const currentType = detectVcsType(workspacePath);
    if (currentType === cached.type) return cached;
    providerCache.delete(workspacePath);
  }

  const type = detectVcsType(workspacePath);
  if (!type) return null;

  const provider = type === 'jj' ? new JjProvider() : new GitProvider();

  if (!provider.isAvailable()) {
    return null;
  }

  providerCache.set(workspacePath, provider);
  return provider;
}

export function clearProviderCache(workspacePath?: string): void {
  if (workspacePath) {
    providerCache.delete(workspacePath);
  } else {
    providerCache.clear();
  }
}
