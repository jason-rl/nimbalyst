import { safeHandle } from '../utils/ipcRegistry';
import { getVcsProvider, detectVcsType } from '../vcs/VcsProviderFactory';
import type { VcsInfo } from '../vcs/types';

export function registerVcsHandlers(): void {
  safeHandle('vcs:info', async (_event, workspacePath: string): Promise<VcsInfo | null> => {
    if (!workspacePath) return null;

    const provider = getVcsProvider(workspacePath);
    if (!provider) return null;

    return {
      type: provider.type,
      terminology: provider.terminology,
    };
  });

  safeHandle('vcs:type', async (_event, workspacePath: string): Promise<string | null> => {
    if (!workspacePath) return null;
    return detectVcsType(workspacePath);
  });
}
