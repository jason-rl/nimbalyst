/**
 * Git IPC Handlers
 *
 * Handles git operations from the renderer process.
 */

import log from 'electron-log/main';
import { gitOperationLock } from '../services/GitOperationLock';
import { safeHandle } from '../utils/ipcRegistry';
import { getVcsProvider } from '../vcs/VcsProviderFactory';

interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  hasUncommitted: boolean;
  baseBranch?: string;
  isMerged?: boolean;
}

interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
  refs?: string;
}

/**
 * Register all git-related IPC handlers
 */
export function registerGitHandlers(): void {
  /**
   * Get git status for a workspace or worktree
   */
  safeHandle('git:status', async (_event, workspacePath: string): Promise<GitStatusResult> => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    const provider = getVcsProvider(workspacePath);
    if (!provider) {
      return { branch: '', ahead: 0, behind: 0, hasUncommitted: false };
    }

    try {
      const status = await provider.getStatus(workspacePath);
      return status;
    } catch (error) {
      log.error('Failed to get git status:', error);
      throw error;
    }
  });

  /**
   * Get recent commits with optional filters
   */
  safeHandle(
    'git:log',
    async (
      _event,
      workspacePath: string,
      limit: number = 10,
      options?: {
        branch?: string;
        author?: string;
        since?: string;
        until?: string;
        aheadBehind?: boolean;
      }
    ): Promise<GitCommit[]> => {
      if (!workspacePath) {
        throw new Error('workspacePath is required');
      }

      const provider = getVcsProvider(workspacePath);
      if (!provider) {
        return [];
      }

      try {
        const commits = await provider.getLog(workspacePath, limit, options);
        return commits.map(c => ({
          hash: c.id,
          message: c.message,
          author: c.author,
          date: c.date,
          refs: c.refs,
        }));
      } catch (error) {
        log.error('Failed to get git log:', error);
        throw error;
      }
    }
  );

  /**
   * List branches
   */
  safeHandle('git:branches', async (_event, workspacePath: string): Promise<{ branches: string[]; current: string }> => {
    if (!workspacePath) throw new Error('workspacePath is required');

    const provider = getVcsProvider(workspacePath);
    if (!provider) return { branches: [], current: '' };

    try {
      const branchInfo = await provider.getBranches(workspacePath);
      return branchInfo;
    } catch (error) {
      log.error('[git:branches] Failed:', error);
      throw error;
    }
  });

  /**
   * Push current branch to remote
   */
  safeHandle(
    'git:push',
    async (_event, workspacePath: string, options?: { force?: boolean; setUpstream?: boolean; remote?: string; branch?: string }):
      Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:push', async () => {
        try {
          const result = await provider.push(workspacePath, options);
          return result;
        } catch (error) {
          log.error('[git:push] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
    }
  );

  /**
   * Pull from remote
   */
  safeHandle(
    'git:pull',
    async (_event, workspacePath: string, options?: { rebase?: boolean; ffOnly?: boolean }):
      Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
      if (!workspacePath) throw new Error('workspacePath is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:pull', async () => {
        try {
          const result = await provider.pull(workspacePath, options);
          return result;
        } catch (error) {
          log.error('[git:pull] Failed:', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
    }
  );

  /**
   * Fetch from remote without merging
   */
  safeHandle(
    'git:fetch',
    async (_event, workspacePath: string, options?: { remote?: string }):
      Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { success: false, error: 'Not a git repository' };

      try {
        const result = await provider.fetch(workspacePath, options);
        return result;
      } catch (error) {
        log.error('[git:fetch] Failed:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  /**
   * Start, continue, or abort a rebase
   */
  safeHandle(
    'git:rebase',
    async (_event, workspacePath: string, options: { target?: string; action?: 'continue' | 'abort' | 'skip' }):
      Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
      if (!workspacePath) throw new Error('workspacePath is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:rebase', async () => {
        try {
          const result = await provider.rebase(workspacePath, options);
          return result;
        } catch (error) {
          log.error('[git:rebase] Failed:', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
    }
  );

  /**
   * Get current rebase status and any conflict files
   */
  safeHandle(
    'git:rebase-status',
    async (_event, workspacePath: string):
      Promise<{ isRebasing: boolean; conflicts: string[]; currentCommit?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { isRebasing: false, conflicts: [] };

      try {
        const status = await provider.getRebaseStatus(workspacePath);
        return status;
      } catch (error) {
        log.error('[git:rebase-status] Failed:', error);
        return { isRebasing: false, conflicts: [] };
      }
    }
  );

  /**
   * Set upstream tracking branch for current branch
   */
  safeHandle(
    'git:set-upstream',
    async (_event, workspacePath: string, remote: string, branch?: string):
      Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!remote) throw new Error('remote is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { success: false, error: 'Not a git repository' };

      try {
        const result = await provider.setUpstream(workspacePath, remote, branch);
        return result;
      } catch (error) {
        log.error('[git:set-upstream] Failed:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  /**
   * Checkout a branch or commit hash (detached HEAD if hash)
   */
  safeHandle(
    'git:checkout',
    async (_event, workspacePath: string, ref: string):
      Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!ref) throw new Error('ref is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:checkout', async () => {
        try {
          const result = await provider.checkout(workspacePath, ref);
          return result;
        } catch (error) {
          log.error('[git:checkout] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
    }
  );

  /**
   * Cherry-pick a commit onto the current branch
   */
  safeHandle(
    'git:cherry-pick',
    async (_event, workspacePath: string, hash: string):
      Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!hash) throw new Error('hash is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:cherry-pick', async () => {
        try {
          const result = await provider.cherryPick(workspacePath, hash);
          return result;
        } catch (error) {
          log.error('[git:cherry-pick] Failed:', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
    }
  );

  /**
   * Create a new branch starting from a given commit
   */
  safeHandle(
    'git:create-branch',
    async (_event, workspacePath: string, branchName: string, fromHash: string):
      Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!branchName) throw new Error('branchName is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:create-branch', async () => {
        try {
          const result = await provider.createBranch(workspacePath, branchName, fromHash || 'HEAD');
          return result;
        } catch (error) {
          log.error('[git:create-branch] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
    }
  );

  /**
   * Get detailed info for a single commit (full message, per-file stats)
   */
  safeHandle(
    'git:commit-detail',
    async (_event, workspacePath: string, hash: string): Promise<{
      body: string;
      files: Array<{ status: string; path: string; added: number; deleted: number }>;
      summary: { filesChanged: number; insertions: number; deletions: number };
    } | null> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!hash) throw new Error('hash is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return null;

      try {
        const detail = await provider.getCommitDetail(workspacePath, hash);
        return detail;
      } catch (error) {
        log.error('[git:commit-detail] Failed:', error);
        throw error;
      }
    }
  );

  /**
   * Get working tree changes (staged, unstaged, untracked files)
   */
  safeHandle(
    'git:working-changes',
    async (_event, workspacePath: string): Promise<{
      staged: Array<{ path: string; status: string }>;
      unstaged: Array<{ path: string; status: string }>;
      untracked: Array<{ path: string }>;
      conflicted: Array<{ path: string }>;
    }> => {
      if (!workspacePath) throw new Error('workspacePath is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) {
        return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      }

      try {
        const changes = await provider.getWorkingChanges(workspacePath);
        return changes;
      } catch (error) {
        log.error('[git:working-changes] Failed:', error);
        throw error;
      }
    }
  );

  /**
   * Stage specific files
   */
  safeHandle(
    'git:stage',
    async (_event, workspacePath: string, files: string[]): Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!files || files.length === 0) throw new Error('files are required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:stage', async () => {
        try {
          const result = await provider.stageFiles(workspacePath, files);
          return result;
        } catch (error) {
          log.error('[git:stage] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
    }
  );

  /**
   * Unstage specific files (git reset HEAD <files>)
   */
  safeHandle(
    'git:unstage',
    async (_event, workspacePath: string, files: string[]): Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!files || files.length === 0) throw new Error('files are required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:unstage', async () => {
        try {
          const result = await provider.unstageFiles(workspacePath, files);
          return result;
        } catch (error) {
          log.error('[git:unstage] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
    }
  );

  /**
   * Discard changes to specific files (git checkout -- <files>)
   */
  safeHandle(
    'git:discard-changes',
    async (_event, workspacePath: string, files: string[]): Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!files || files.length === 0) throw new Error('files are required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:discard-changes', async () => {
        try {
          const result = await provider.discardChanges(workspacePath, files);
          return result;
        } catch (error) {
          log.error('[git:discard-changes] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
    }
  );

  /**
   * Get file content at a specific commit
   */
  safeHandle(
    'git:show-file',
    async (_event, workspacePath: string, hash: string, filePath: string): Promise<string> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!hash) throw new Error('hash is required');
      if (!filePath) throw new Error('filePath is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) return '';

      try {
        const content = await provider.showFile(workspacePath, hash, filePath);
        return content;
      } catch (error) {
        log.error('[git:show-file] Failed:', error);
        return '';
      }
    }
  );

  /**
   * Get file diff
   */
  safeHandle(
    'git:diff',
    async (_event, workspacePath: string, filePath: string): Promise<string> => {
      if (!workspacePath) {
        throw new Error('workspacePath is required');
      }
      if (!filePath) {
        throw new Error('filePath is required');
      }

      const provider = getVcsProvider(workspacePath);
      if (!provider) {
        return '';
      }

      try {
        const diff = await provider.getDiff(workspacePath, filePath);
        return diff;
      } catch (error) {
        log.error('Failed to get file diff:', error);
        throw error;
      }
    }
  );

  /**
   * Get a typed diff for a single file scoped to a working-tree group.
   * Cleanly separates staged vs unstaged vs untracked diffs (the legacy
   * `git:diff` channel mixes them by diffing HEAD against the working tree).
   *
   * The `working` group returns the combined HEAD-vs-working-tree diff for a file
   * regardless of staging state, falling back to a synthesized diff for untracked
   * files. This is what tools like the git commit proposal widget want when they
   * need to show "what's about to be committed" without knowing the file's group.
   */
  safeHandle(
    'git:file-diff',
    async (
      _event,
      workspacePath: string,
      args: { path: string; group: 'staged' | 'unstaged' | 'untracked' | 'conflicted' | 'working' }
    ): Promise<{
      unifiedDiff: string;
      isBinary: boolean;
      truncated?: boolean;
    }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!args?.path) throw new Error('path is required');

      const provider = getVcsProvider(workspacePath);
      if (!provider) {
        return { unifiedDiff: '', isBinary: false };
      }

      try {
        const diff = await provider.getFileDiff(workspacePath, args);
        return diff;
      } catch (error) {
        log.error(`[git:file-diff] Failed for ${args.group}/${args.path}:`, error);
        throw error;
      }
    }
  );

  /**
   * Get the unified diff for a single file in a specific commit.
   * Uses `git show --format=` so the output contains only the per-file diff
   * (no commit metadata header). Works for the initial commit too --
   * git show synthesizes a diff against /dev/null in that case.
   */
  safeHandle(
    'git:commit-file-diff',
    async (
      _event,
      workspacePath: string,
      hash: string,
      filePath: string
    ): Promise<{ unifiedDiff: string; isBinary: boolean }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!hash) throw new Error('hash is required');
      if (!filePath) throw new Error('filePath is required');
      if (!isGitRepository(workspacePath)) {
        return { unifiedDiff: '', isBinary: false };
      }

      try {
        const git: SimpleGit = simpleGit(workspacePath);
        const diff = await git.raw(['show', '--no-color', '--format=', hash, '--', filePath]);
        return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
      } catch (error) {
        log.error(`[git:commit-file-diff] Failed for ${hash}/${filePath}:`, error);
        throw error;
      }
    }
  );

  /**
   * Execute git commit
   */
  safeHandle(
    'git:commit',
    async (
      _event,
      workspacePath: string,
      message: string,
      filesToStage: string[]
    ): Promise<{ success: boolean; commitHash?: string; commitDate?: string; error?: string }> => {
      if (!workspacePath) {
        throw new Error('workspacePath is required');
      }
      if (!message) {
        throw new Error('message is required');
      }

      const provider = getVcsProvider(workspacePath);
      if (!provider) {
        return { success: false, error: 'Not a git repository' };
      }

      return gitOperationLock.withLock(workspacePath, 'git:commit', async () => {
        try {
          log.info(`[git:commit] Starting commit in ${workspacePath} with ${filesToStage?.length || 0} files`);

          const result = await provider.commit(workspacePath, message, filesToStage);

          if (result.success) {
            log.info(`[git:commit] Successfully committed: ${result.commitHash}`);
          } else {
            log.warn(`[git:commit] Commit failed: ${result.error}`);
          }

          return result;
        } catch (error) {
          log.error('[git:commit] Failed to commit:', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
    }
  );

  log.info('Git IPC handlers registered');
}
