import simpleGit, { SimpleGit, DiffResult } from 'simple-git';
import { execFile } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { promisify } from 'util';
import log from 'electron-log/main';
import { isGitAvailable, getNormalizedGitRemote } from '../../utils/gitUtils';
import { gitOperationLock } from '../../services/GitOperationLock';
import { GitWorktreeService } from '../../services/GitWorktreeService';
import { GitStatusService } from '../../services/GitStatusService';
import type { VcsProvider } from '../VcsProvider';
import { GIT_TERMINOLOGY } from '../types';
import type {
  VcsStatus,
  VcsCommit,
  VcsFileStatus,
  VcsFileStatusResult,
  VcsWorkingChanges,
  VcsBranchInfo,
  VcsCommitDetail,
  VcsFileDiff,
  VcsRepoState,
  VcsIsolatedEnv,
  VcsIsolatedEnvStatus,
  VcsIsolatedEnvListEntry,
  VcsMergeResult,
  VcsCommitResult,
  VcsOperationResult,
  VcsOperationResultWithConflicts,
  VcsWatchPaths,
} from '../types';

const logger = log.scope('GitProvider');
const execFileAsync = promisify(execFile);

export class GitProvider implements VcsProvider {
  readonly type = 'git' as const;
  readonly terminology = GIT_TERMINOLOGY;

  private worktreeService = new GitWorktreeService();
  private statusService = new GitStatusService();

  isAvailable(): boolean {
    return isGitAvailable();
  }

  async isRepository(workspacePath: string): Promise<boolean> {
    return existsSync(join(workspacePath, '.git'));
  }

  async isIsolatedEnv(workspacePath: string): Promise<boolean> {
    return this.statusService.isGitWorktree(workspacePath);
  }

  async getStatus(workspacePath: string): Promise<VcsStatus> {
    if (!await this.isRepository(workspacePath)) {
      return { branch: '', ahead: 0, behind: 0, hasUncommitted: false };
    }

    const git: SimpleGit = simpleGit(workspacePath, { config: ['core.optionalLocks=false'] });
    const status = await git.status();
    const branch = status.current || 'HEAD';

    return {
      branch,
      ahead: status.ahead || 0,
      behind: status.behind || 0,
      hasUncommitted: !status.isClean(),
    };
  }

  async getFileStatuses(workspacePath: string, filePaths: string[]): Promise<VcsFileStatusResult> {
    return this.statusService.getFileStatus(workspacePath, filePaths);
  }

  async getAllFileStatuses(workspacePath: string): Promise<VcsFileStatusResult> {
    return this.statusService.getAllFileStatuses(workspacePath);
  }

  async getUncommittedFiles(workspacePath: string): Promise<string[]> {
    return this.statusService.getUncommittedFiles(workspacePath);
  }

  async getWorkingChanges(workspacePath: string): Promise<VcsWorkingChanges> {
    if (!await this.isRepository(workspacePath)) {
      return { staged: [], unstaged: [], untracked: [], conflicted: [] };
    }

    const git: SimpleGit = simpleGit(workspacePath);
    const status = await git.status();

    return {
      staged: status.staged.map(path => ({ path, status: 'A' })),
      unstaged: status.modified.map(path => ({ path, status: 'M' })),
      untracked: status.not_added.map(path => ({ path })),
      conflicted: status.conflicted.map(path => ({ path })),
    };
  }

  async getRepoState(workspacePath: string): Promise<VcsRepoState> {
    const gitDir = join(workspacePath, '.git');
    const git: SimpleGit = simpleGit(workspacePath);
    const status = await git.status();

    const inMerge = existsSync(join(gitDir, 'MERGE_HEAD'));
    const inRebase = existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'));
    const inCherryPick = existsSync(join(gitDir, 'CHERRY_PICK_HEAD'));
    const inRevert = existsSync(join(gitDir, 'REVERT_HEAD'));

    return {
      isClean: !inMerge && !inRebase && !inCherryPick && !inRevert,
      inMerge,
      inRebase,
      inCherryPick,
      inRevert,
      conflictedFiles: status.conflicted || [],
    };
  }

  async getLog(workspacePath: string, limit: number, options?: {
    branch?: string;
    author?: string;
    since?: string;
    until?: string;
  }): Promise<VcsCommit[]> {
    if (!await this.isRepository(workspacePath)) {
      return [];
    }

    const git: SimpleGit = simpleGit(workspacePath);

    if (!await this.hasCommits(git)) {
      return [];
    }

    const RS = '\x1e';
    const rawArgs: string[] = [
      `--format=${RS}%H%n%s%n%an%n%ai%n%D`,
      `--max-count=${Math.min(limit, 200)}`,
    ];

    if (options?.author) {
      rawArgs.push(`--author=${options.author}`);
    }
    if (options?.since) {
      rawArgs.push(`--since=${options.since}`);
    }
    if (options?.until) {
      rawArgs.push(`--until=${options.until}`);
    }
    if (options?.branch) {
      rawArgs.push(options.branch);
    }

    const rawOutput = await git.raw(['log', ...rawArgs]);

    if (!rawOutput.trim()) {
      return [];
    }

    const commits: VcsCommit[] = [];
    for (const entry of rawOutput.split(RS)) {
      if (!entry.trim()) continue;
      const lines = entry.trim().split('\n');
      if (lines.length < 4) continue;
      const hash = lines[0]?.trim() || '';
      if (!hash) continue;
      commits.push({
        id: hash,
        shortId: hash.slice(0, 7),
        message: lines[1]?.trim() || '',
        author: lines[2]?.trim() || '',
        date: lines[3]?.trim() || '',
        refs: lines[4]?.trim() || '',
      });
    }
    return commits;
  }

  async getCommitDetail(workspacePath: string, id: string): Promise<VcsCommitDetail | null> {
    if (!await this.isRepository(workspacePath)) {
      return null;
    }

    const git: SimpleGit = simpleGit(workspacePath);

    try {
      const showResult = await git.show([id, '--stat', '--format=%B']);
      const lines = showResult.split('\n');

      const bodyEndIndex = lines.findIndex(line => line.trim() === '');
      const body = lines.slice(0, bodyEndIndex).join('\n');

      const statLines = lines.slice(bodyEndIndex + 1).filter(line => line.trim() && !line.includes('files changed'));

      const files = statLines.map(line => {
        const match = line.match(/^(.+?)\s+\|\s+(\d+)\s+([+-]+)$/);
        if (!match) return null;

        const path = match[1].trim();
        const changes = parseInt(match[2], 10);
        const diffChars = match[3];
        const added = diffChars.split('').filter(c => c === '+').length;
        const deleted = diffChars.split('').filter(c => c === '-').length;

        return { status: 'M', path, added, deleted };
      }).filter((f): f is NonNullable<typeof f> => f !== null);

      const summary = {
        filesChanged: files.length,
        insertions: files.reduce((sum, f) => sum + f.added, 0),
        deletions: files.reduce((sum, f) => sum + f.deleted, 0),
      };

      return { body, files, summary };
    } catch (error) {
      logger.error('Failed to get commit detail:', error);
      return null;
    }
  }

  async showFile(workspacePath: string, ref: string, filePath: string): Promise<string> {
    const git: SimpleGit = simpleGit(workspacePath);
    return git.show([`${ref}:${filePath}`]);
  }

  async getBranches(workspacePath: string): Promise<VcsBranchInfo> {
    if (!await this.isRepository(workspacePath)) {
      return { branches: [], current: '' };
    }

    const git: SimpleGit = simpleGit(workspacePath);
    const summary = await git.branch();
    let current = summary.current;
    let branches = summary.all;

    if (!current) {
      const status = await git.status();
      current = status.current || '';
    }
    if (current && branches.length === 0) {
      branches = [current];
    }

    return { branches, current };
  }

  async createBranch(workspacePath: string, name: string, fromRef: string): Promise<VcsOperationResult> {
    return gitOperationLock.withLock(workspacePath, 'createBranch', async () => {
      try {
        const git: SimpleGit = simpleGit(workspacePath);
        await git.checkoutBranch(name, fromRef);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async checkout(workspacePath: string, ref: string): Promise<VcsOperationResult> {
    return gitOperationLock.withLock(workspacePath, 'checkout', async () => {
      try {
        const git: SimpleGit = simpleGit(workspacePath);
        await git.checkout(ref);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async stageFiles(workspacePath: string, files: string[]): Promise<VcsOperationResult> {
    return gitOperationLock.withLock(workspacePath, 'stageFiles', async () => {
      try {
        const git: SimpleGit = simpleGit(workspacePath);
        await git.add(files);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async unstageFiles(workspacePath: string, files: string[]): Promise<VcsOperationResult> {
    return gitOperationLock.withLock(workspacePath, 'unstageFiles', async () => {
      try {
        const git: SimpleGit = simpleGit(workspacePath);
        if (!await this.hasCommits(git)) {
          await git.raw(['rm', '--cached', ...files]);
        } else {
          await git.reset(['HEAD', '--', ...files]);
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async discardChanges(workspacePath: string, files: string[]): Promise<VcsOperationResult> {
    return gitOperationLock.withLock(workspacePath, 'discardChanges', async () => {
      try {
        const git: SimpleGit = simpleGit(workspacePath);
        await git.checkout(['--', ...files]);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async commit(workspacePath: string, message: string, filesToStage?: string[]): Promise<VcsCommitResult> {
    return gitOperationLock.withLock(workspacePath, 'commit', async () => {
      try {
        const git: SimpleGit = simpleGit(workspacePath);

        if (filesToStage && filesToStage.length > 0) {
          await git.add(filesToStage);
        }

        const result = await git.commit(message);

        return {
          success: true,
          commitHash: result.commit,
          commitDate: new Date().toISOString(),
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async push(workspacePath: string, options?: {
    force?: boolean;
    setUpstream?: boolean;
    remote?: string;
    branch?: string;
  }): Promise<VcsOperationResult> {
    return gitOperationLock.withLock(workspacePath, 'push', async () => {
      try {
        const git: SimpleGit = simpleGit(workspacePath);
        const status = await git.status();
        const branch = options?.branch || status.current || '';
        const remote = options?.remote || 'origin';

        const pushArgs: string[] = [];

        if (options?.setUpstream) {
          pushArgs.push('--set-upstream', remote, branch);
        } else if (options?.force) {
          pushArgs.push('--force-with-lease');
        }

        await git.push(remote, branch, pushArgs);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async pull(workspacePath: string, options?: {
    rebase?: boolean;
    ffOnly?: boolean;
  }): Promise<VcsOperationResultWithConflicts> {
    return gitOperationLock.withLock(workspacePath, 'pull', async () => {
      try {
        const git: SimpleGit = simpleGit(workspacePath);
        const pullArgs: string[] = [];
        if (options?.rebase) {
          pullArgs.push('--rebase');
        } else if (options?.ffOnly) {
          pullArgs.push('--ff-only');
        }
        await git.pull(undefined, undefined, pullArgs);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('CONFLICT') || message.includes('conflict')) {
          const git: SimpleGit = simpleGit(workspacePath);
          const status = await git.status();
          return { success: false, error: message, conflicts: status.conflicted };
        }

        return { success: false, error: message };
      }
    });
  }

  async fetch(workspacePath: string, options?: { remote?: string }): Promise<VcsOperationResult> {
    try {
      const git: SimpleGit = simpleGit(workspacePath);
      await git.fetch(options?.remote || 'origin');
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async setUpstream(workspacePath: string, remote: string, branch?: string): Promise<VcsOperationResult> {
    try {
      const git: SimpleGit = simpleGit(workspacePath);
      const status = await git.status();
      const targetBranch = branch || status.current || '';
      await git.push(['--set-upstream', remote, targetBranch]);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async rebase(workspacePath: string, options: {
    target?: string;
    action?: 'continue' | 'abort' | 'skip';
  }): Promise<VcsOperationResultWithConflicts> {
    return gitOperationLock.withLock(workspacePath, 'rebase', async () => {
      try {
        const git: SimpleGit = simpleGit(workspacePath);

        if (options.action === 'continue') {
          await git.rebase(['--continue']);
        } else if (options.action === 'abort') {
          await git.rebase(['--abort']);
        } else if (options.action === 'skip') {
          await git.rebase(['--skip']);
        } else if (options.target) {
          await git.rebase([options.target]);
        } else {
          throw new Error('rebase requires either a target branch or an action (continue/abort/skip)');
        }

        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('CONFLICT') || message.includes('conflict')) {
          const git: SimpleGit = simpleGit(workspacePath);
          const status = await git.status();
          return { success: false, error: message, conflicts: status.conflicted };
        }

        return { success: false, error: message };
      }
    });
  }

  async getRebaseStatus(workspacePath: string): Promise<{
    isRebasing: boolean;
    conflicts: string[];
    currentCommit?: string;
  }> {
    if (!await this.isRepository(workspacePath)) {
      return { isRebasing: false, conflicts: [] };
    }

    const rebaseHeadPath = join(workspacePath, '.git', 'REBASE_HEAD');
    const isRebasing = existsSync(rebaseHeadPath);

    if (!isRebasing) {
      return { isRebasing: false, conflicts: [] };
    }

    const git: SimpleGit = simpleGit(workspacePath);
    const status = await git.status();

    return {
      isRebasing: true,
      conflicts: status.conflicted,
    };
  }

  async getFileDiff(workspacePath: string, args: {
    path: string;
    group: 'staged' | 'unstaged' | 'untracked' | 'conflicted' | 'working';
  }): Promise<VcsFileDiff> {
    const git: SimpleGit = simpleGit(workspacePath);
    let diffOutput = '';

    try {
      if (args.group === 'staged') {
        diffOutput = await git.diff(['--cached', '--', args.path]);
      } else if (args.group === 'unstaged') {
        diffOutput = await git.diff(['--', args.path]);
      } else {
        diffOutput = await git.diff(['--', args.path]);
      }

      const isBinary = diffOutput.includes('Binary files') || diffOutput.includes('GIT binary patch');

      return {
        unifiedDiff: diffOutput,
        isBinary,
        truncated: false,
      };
    } catch (error) {
      logger.error('Failed to get file diff:', error);
      return {
        unifiedDiff: '',
        isBinary: false,
        truncated: false,
      };
    }
  }

  async getDiff(workspacePath: string, filePath: string): Promise<string> {
    const git: SimpleGit = simpleGit(workspacePath);
    return git.diff(['--', filePath]);
  }

  async cherryPick(workspacePath: string, id: string): Promise<VcsOperationResultWithConflicts> {
    return gitOperationLock.withLock(workspacePath, 'cherryPick', async () => {
      try {
        const git: SimpleGit = simpleGit(workspacePath);
        await git.raw(['cherry-pick', id]);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('CONFLICT') || message.includes('conflict')) {
          const git: SimpleGit = simpleGit(workspacePath);
          const status = await git.status();
          return { success: false, error: message, conflicts: status.conflicted };
        }

        return { success: false, error: message };
      }
    });
  }

  async createIsolatedEnv(workspacePath: string, options?: {
    name?: string;
    baseBranch?: string;
  }): Promise<VcsIsolatedEnv> {
    const worktree = await this.worktreeService.createWorktree(workspacePath, options);
    return worktree;
  }

  async deleteIsolatedEnv(envPath: string, workspacePath: string): Promise<void> {
    await this.worktreeService.deleteWorktree(envPath, workspacePath);
  }

  async listIsolatedEnvs(workspacePath: string): Promise<VcsIsolatedEnvListEntry[]> {
    return this.worktreeService.listWorktrees(workspacePath);
  }

  async getIsolatedEnvStatus(envPath: string, baseBranch?: string): Promise<VcsIsolatedEnvStatus> {
    return this.worktreeService.getWorktreeStatus(envPath, baseBranch);
  }

  async validateIsolatedEnv(envPath: string, expectedBranch?: string): Promise<{ valid: boolean; issues: string[] }> {
    return this.worktreeService.validateWorktree(envPath, expectedBranch);
  }

  async getIsolatedEnvCommits(envPath: string, baseBranch?: string): Promise<Array<VcsCommit & { files: string[]; hasEquivalentOnBase?: boolean }>> {
    const commits = await this.worktreeService.getWorktreeCommits(envPath, baseBranch);
    return commits.map(c => ({
      id: c.hash,
      shortId: c.shortHash,
      message: c.message,
      author: c.author,
      date: c.date.toISOString(),
      files: c.files,
      hasEquivalentOnBase: c.hasEquivalentOnBase,
    }));
  }

  async getIsolatedEnvChangedFiles(envPath: string): Promise<Array<{ path: string; status: string }>> {
    const files = await this.worktreeService.getChangedFiles(envPath);
    return files.map(f => ({
      path: f.path,
      status: f.status,
    }));
  }

  async getIsolatedEnvFileDiff(envPath: string, filePath: string, baseBranch?: string): Promise<{
    filePath: string;
    diff: string;
    oldContent: string;
    newContent: string;
    status: 'added' | 'modified' | 'deleted';
  }> {
    return this.worktreeService.getFileDiff(envPath, filePath, baseBranch);
  }

  async mergeToMain(envPath: string, mainRepoPath: string): Promise<VcsMergeResult> {
    return this.worktreeService.mergeToMain(envPath, mainRepoPath);
  }

  async rebaseFromBase(envPath: string, baseBranch: string): Promise<VcsMergeResult> {
    const result = await this.worktreeService.rebaseFromBase(envPath, baseBranch);
    return {
      success: result.success,
      message: result.message || '',
      conflictedFiles: result.conflictedFiles,
      stashWarning: result.stashWarning,
    };
  }

  async squashCommits(envPath: string, commitIds: string[], message: string): Promise<string> {
    return this.worktreeService.squashCommits(envPath, commitIds, message);
  }

  async commitInEnv(envPath: string, message: string, files?: string[]): Promise<VcsCommitResult> {
    try {
      const commitInfo = await this.worktreeService.commitChanges(envPath, message, files);
      return {
        success: true,
        commitHash: commitInfo.hash,
        commitDate: commitInfo.date.toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async stageInEnv(envPath: string, files: string[], stage: boolean): Promise<VcsOperationResult> {
    if (stage) {
      return this.stageFiles(envPath, files);
    } else {
      return this.unstageFiles(envPath, files);
    }
  }

  async stageAllInEnv(envPath: string, stage: boolean): Promise<VcsOperationResult> {
    return gitOperationLock.withLock(envPath, 'stageAll', async () => {
      try {
        const git: SimpleGit = simpleGit(envPath);
        if (stage) {
          await git.add('-A');
        } else {
          await git.reset();
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async checkCommitsExistElsewhere(envPath: string, commitHashes: string[]): Promise<boolean> {
    return this.worktreeService.checkCommitsExistElsewhere(envPath, commitHashes);
  }

  async getRepoCurrentBranch(repoPath: string): Promise<string> {
    return this.worktreeService.getRepoCurrentBranch(repoPath);
  }

  async revParse(workspacePath: string, ref: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', ref], {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000,
      });
      return stdout.trim();
    } catch (error) {
      throw new Error(`Failed to rev-parse ${ref}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async showAtRef(workspacePath: string, ref: string, relativePath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['show', `${ref}:${relativePath}`], {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      throw new Error(`Failed to show ${ref}:${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async statusPorcelain(workspacePath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000,
      });
      return stdout;
    } catch (error) {
      throw new Error(`Failed to get status --porcelain: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getModifiedFilesVsBase(workspacePath: string): Promise<string[]> {
    return this.statusService.getWorktreeModifiedFiles(workspacePath);
  }

  async getWatchPaths(workspacePath: string): Promise<VcsWatchPaths | null> {
    const gitPath = join(workspacePath, '.git');

    try {
      const stat = statSync(gitPath);
      let gitDir = gitPath;
      let commonDir = gitPath;

      if (stat.isFile()) {
        const content = readFileSync(gitPath, 'utf-8');
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match) {
          gitDir = match[1].trim();
          if (!gitDir.startsWith('/')) {
            gitDir = resolve(workspacePath, gitDir);
          }

          const commonDirFile = join(gitDir, 'commondir');
          try {
            const commonDirContent = readFileSync(commonDirFile, 'utf-8');
            let commonDirPath = commonDirContent.trim();
            if (!commonDirPath.startsWith('/')) {
              commonDirPath = resolve(gitDir, commonDirPath);
            }
            commonDir = commonDirPath;
          } catch {
            commonDir = gitDir;
          }
        }
      }

      const git: SimpleGit = simpleGit(workspacePath);
      const status = await git.status();
      const currentBranch = status.current;

      if (!currentBranch) {
        return null;
      }

      const branchRefPath = join(commonDir, 'refs/heads', currentBranch);
      const indexPath = join(gitDir, 'index');

      return {
        commitWatchPaths: [branchRefPath],
        indexWatchPaths: [indexPath],
      };
    } catch {
      return null;
    }
  }

  async getNormalizedRemote(workspacePath: string): Promise<string | null> {
    return getNormalizedGitRemote(workspacePath);
  }

  async listIgnoredFiles(envPath: string): Promise<Array<{ path: string; isDir: boolean }>> {
    const files = await this.worktreeService.listGitignoredFiles(envPath);
    return files.map(path => ({
      path,
      isDir: false,
    }));
  }

  async cleanIgnoredFiles(envPath: string): Promise<string[]> {
    return this.worktreeService.cleanGitignoredFiles(envPath);
  }

  clearStatusCache(workspacePath?: string): void {
    this.statusService.clearCache(workspacePath);
  }

  private async hasCommits(git: SimpleGit): Promise<boolean> {
    try {
      await git.revparse(['HEAD']);
      return true;
    } catch {
      return false;
    }
  }
}
