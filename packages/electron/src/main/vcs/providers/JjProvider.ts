import { existsSync } from 'fs';
import { join } from 'path';
import { ulid } from 'ulid';
import log from 'electron-log/main';
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
import { JJ_TERMINOLOGY } from '../types';
import type { VcsProvider } from '../VcsProvider';
import { JjCli } from './JjCli';

const logger = log.scope('JjProvider');
const jjCli = new JjCli();

export class JjProvider implements VcsProvider {
  readonly type = 'jj' as const;
  readonly terminology = JJ_TERMINOLOGY;

  isAvailable(): boolean {
    return jjCli.isAvailable();
  }

  async isRepository(workspacePath: string): Promise<boolean> {
    return existsSync(join(workspacePath, '.jj'));
  }

  async isIsolatedEnv(workspacePath: string): Promise<boolean> {
    try {
      const output = await jjCli.exec(['workspace', 'list'], { cwd: workspacePath });
      const lines = output.split('\n').filter((line) => line.trim());
      if (lines.length === 0) return false;

      for (const line of lines) {
        const parts = line.split(':').map((p) => p.trim());
        if (parts.length < 2) continue;
        const wsPath = parts[1];
        if (wsPath === workspacePath) {
          return parts[0] !== 'default';
        }
      }
      return false;
    } catch (error) {
      logger.error('Failed to check if isolated env', { workspacePath, error });
      return false;
    }
  }

  async getStatus(workspacePath: string): Promise<VcsStatus> {
    try {
      const bookmarksOutput = await jjCli.exec(
        ['log', '-r', '@', '--no-graph', '-T', 'bookmarks'],
        { cwd: workspacePath }
      );
      const bookmarks = bookmarksOutput.trim();
      const branch = bookmarks || await this.getShortChangeId(workspacePath);

      let ahead = 0;
      try {
        const logOutput = await jjCli.exec(
          ['log', '-r', 'trunk()..@-', '--no-graph', '-T', 'change_id'],
          { cwd: workspacePath }
        );
        const commits = logOutput.trim().split('\n').filter((line) => line.trim());
        ahead = commits.length;
      } catch (error) {
        logger.warn('Failed to count commits ahead', { workspacePath, error });
      }

      const statusOutput = await jjCli.exec(['status'], { cwd: workspacePath });
      const hasUncommitted = statusOutput.includes('Working copy changes:');

      return {
        branch,
        ahead,
        behind: 0,
        hasUncommitted,
      };
    } catch (error) {
      logger.error('Failed to get status', { workspacePath, error });
      throw error;
    }
  }

  async getFileStatuses(workspacePath: string, filePaths: string[]): Promise<VcsFileStatusResult> {
    const result: VcsFileStatusResult = {};

    try {
      const statusOutput = await jjCli.exec(['status'], { cwd: workspacePath });
      const statusMap = this.parseStatusOutput(statusOutput);

      for (const filePath of filePaths) {
        result[filePath] = statusMap[filePath] || {
          filePath,
          status: 'unchanged',
        };
      }
    } catch (error) {
      logger.error('Failed to get file statuses', { workspacePath, error });
    }

    return result;
  }

  async getAllFileStatuses(workspacePath: string): Promise<VcsFileStatusResult> {
    try {
      const statusOutput = await jjCli.exec(['status'], { cwd: workspacePath });
      return this.parseStatusOutput(statusOutput);
    } catch (error) {
      logger.error('Failed to get all file statuses', { workspacePath, error });
      return {};
    }
  }

  async getUncommittedFiles(workspacePath: string): Promise<string[]> {
    try {
      const statusOutput = await jjCli.exec(['status'], { cwd: workspacePath });
      const statusMap = this.parseStatusOutput(statusOutput);
      return Object.keys(statusMap);
    } catch (error) {
      logger.error('Failed to get uncommitted files', { workspacePath, error });
      return [];
    }
  }

  async getWorkingChanges(workspacePath: string): Promise<VcsWorkingChanges> {
    try {
      const statusOutput = await jjCli.exec(['status'], { cwd: workspacePath });
      const statusMap = this.parseStatusOutput(statusOutput);

      const unstaged: Array<{ path: string; status: string }> = [];
      const conflicted: Array<{ path: string }> = [];

      for (const [path, fileStatus] of Object.entries(statusMap)) {
        if (fileStatus.statusCode === 'C') {
          conflicted.push({ path });
        } else if (fileStatus.status !== 'unchanged') {
          unstaged.push({
            path,
            status: fileStatus.statusCode || fileStatus.status,
          });
        }
      }

      return {
        staged: [],
        unstaged,
        untracked: [],
        conflicted,
      };
    } catch (error) {
      logger.error('Failed to get working changes', { workspacePath, error });
      return { staged: [], unstaged: [], untracked: [], conflicted: [] };
    }
  }

  async getRepoState(workspacePath: string): Promise<VcsRepoState> {
    try {
      const statusOutput = await jjCli.exec(['status'], { cwd: workspacePath });
      const conflicted = statusOutput.includes('conflict');
      const conflictedFiles: string[] = [];

      if (conflicted) {
        const statusMap = this.parseStatusOutput(statusOutput);
        for (const [path, status] of Object.entries(statusMap)) {
          if (status.statusCode === 'C') {
            conflictedFiles.push(path);
          }
        }
      }

      return {
        isClean: !statusOutput.includes('Working copy changes:'),
        inMerge: false,
        inRebase: false,
        inCherryPick: false,
        inRevert: false,
        conflictedFiles,
      };
    } catch (error) {
      logger.error('Failed to get repo state', { workspacePath, error });
      return {
        isClean: false,
        inMerge: false,
        inRebase: false,
        inCherryPick: false,
        inRevert: false,
        conflictedFiles: [],
      };
    }
  }

  async getLog(
    workspacePath: string,
    limit: number,
    options?: {
      branch?: string;
      author?: string;
      since?: string;
      until?: string;
    }
  ): Promise<VcsCommit[]> {
    try {
      const args = [
        'log',
        '--no-graph',
        '-T',
        'change_id ++ "\\t" ++ commit_id ++ "\\t" ++ description.first_line() ++ "\\t" ++ author.name() ++ "\\t" ++ author.timestamp().utc() ++ "\\t" ++ bookmarks',
      ];

      if (limit > 0) {
        args.push('--limit', limit.toString());
      }

      if (options?.branch) {
        args.push('-r', options.branch);
      } else {
        args.push('-r', 'all()');
      }

      const output = await jjCli.exec(args, { cwd: workspacePath });
      const lines = output.split('\n').filter((line) => line.trim());

      return lines.map((line) => {
        const parts = line.split('\t');
        const changeId = parts[0] || '';
        const commitId = parts[1] || '';
        const message = parts[2] || '';
        const author = parts[3] || '';
        const date = parts[4] || '';
        const refs = parts[5] || '';

        return {
          id: changeId,
          shortId: changeId.slice(0, 12),
          contentHash: commitId,
          message,
          author,
          date,
          refs: refs || undefined,
        };
      });
    } catch (error) {
      logger.error('Failed to get log', { workspacePath, error });
      return [];
    }
  }

  async getCommitDetail(workspacePath: string, id: string): Promise<VcsCommitDetail | null> {
    try {
      const showOutput = await jjCli.exec(['show', id, '--stat'], { cwd: workspacePath });
      const metaOutput = await jjCli.exec(
        [
          'log',
          '-r',
          id,
          '-T',
          'description ++ "\\n---\\n" ++ author.name() ++ " <" ++ author.email() ++ ">\\n" ++ author.timestamp().utc()',
        ],
        { cwd: workspacePath }
      );

      const files: Array<{ status: string; path: string; added: number; deleted: number }> = [];
      let totalInsertions = 0;
      let totalDeletions = 0;

      const statLines = showOutput.split('\n');
      for (const line of statLines) {
        const match = line.match(/^\s*(\w+)\s+(.+?)\s+\|\s+(\d+)\s+([+-]+)$/);
        if (match) {
          const [, status, path, changes] = match;
          const added = (match[4].match(/\+/g) || []).length;
          const deleted = (match[4].match(/-/g) || []).length;

          files.push({
            status: status.toUpperCase(),
            path,
            added,
            deleted,
          });

          totalInsertions += added;
          totalDeletions += deleted;
        }
      }

      return {
        body: metaOutput,
        files,
        summary: {
          filesChanged: files.length,
          insertions: totalInsertions,
          deletions: totalDeletions,
        },
      };
    } catch (error) {
      logger.error('Failed to get commit detail', { workspacePath, id, error });
      return null;
    }
  }

  async showFile(workspacePath: string, ref: string, filePath: string): Promise<string> {
    try {
      return await jjCli.exec(['file', 'show', filePath, '-r', ref], { cwd: workspacePath });
    } catch (error) {
      logger.error('Failed to show file', { workspacePath, ref, filePath, error });
      throw error;
    }
  }

  async getBranches(workspacePath: string): Promise<VcsBranchInfo> {
    try {
      const bookmarksOutput = await jjCli.exec(
        ['bookmark', 'list', '--all', '-T', 'name ++ "\\n"'],
        { cwd: workspacePath }
      );
      const branches = bookmarksOutput
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line);

      const currentOutput = await jjCli.exec(
        ['log', '-r', '@', '--no-graph', '-T', 'bookmarks'],
        { cwd: workspacePath }
      );
      const current = currentOutput.trim() || await this.getShortChangeId(workspacePath);

      return { branches, current };
    } catch (error) {
      logger.error('Failed to get branches', { workspacePath, error });
      return { branches: [], current: '' };
    }
  }

  async createBranch(workspacePath: string, name: string, fromRef: string): Promise<VcsOperationResult> {
    try {
      await jjCli.exec(['bookmark', 'create', name, '-r', fromRef], { cwd: workspacePath });
      return { success: true };
    } catch (error) {
      logger.error('Failed to create branch', { workspacePath, name, fromRef, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkout(workspacePath: string, ref: string): Promise<VcsOperationResult> {
    try {
      await jjCli.exec(['edit', ref], { cwd: workspacePath });
      return { success: true };
    } catch (error) {
      logger.error('Failed to checkout', { workspacePath, ref, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async stageFiles(_workspacePath: string, _files: string[]): Promise<VcsOperationResult> {
    return { success: true };
  }

  async unstageFiles(_workspacePath: string, _files: string[]): Promise<VcsOperationResult> {
    return { success: true };
  }

  async discardChanges(workspacePath: string, files: string[]): Promise<VcsOperationResult> {
    try {
      await jjCli.exec(['restore', ...files], { cwd: workspacePath });
      return { success: true };
    } catch (error) {
      logger.error('Failed to discard changes', { workspacePath, files, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async commit(workspacePath: string, message: string, _filesToStage?: string[]): Promise<VcsCommitResult> {
    try {
      await jjCli.exec(['commit', '-m', message], { cwd: workspacePath });

      const changeIdOutput = await jjCli.exec(
        ['log', '-r', '@-', '--no-graph', '-T', 'change_id'],
        { cwd: workspacePath }
      );
      const commitHash = changeIdOutput.trim();

      return {
        success: true,
        commitHash,
        commitDate: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Failed to commit', { workspacePath, message, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async push(
    workspacePath: string,
    options?: {
      force?: boolean;
      setUpstream?: boolean;
      remote?: string;
      branch?: string;
    }
  ): Promise<VcsOperationResult> {
    try {
      const args = ['git', 'push'];

      if (options?.branch) {
        args.push('-b', options.branch);
      } else {
        args.push('--all');
      }

      if (options?.force) {
        args.push('--force');
      }

      await jjCli.exec(args, { cwd: workspacePath });
      return { success: true };
    } catch (error) {
      logger.error('Failed to push', { workspacePath, options, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async pull(
    workspacePath: string,
    _options?: {
      rebase?: boolean;
      ffOnly?: boolean;
    }
  ): Promise<VcsOperationResultWithConflicts> {
    try {
      await jjCli.exec(['git', 'fetch'], { cwd: workspacePath });
      return { success: true };
    } catch (error) {
      logger.error('Failed to pull', { workspacePath, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async fetch(
    workspacePath: string,
    _options?: {
      remote?: string;
    }
  ): Promise<VcsOperationResult> {
    try {
      await jjCli.exec(['git', 'fetch'], { cwd: workspacePath });
      return { success: true };
    } catch (error) {
      logger.error('Failed to fetch', { workspacePath, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async setUpstream(workspacePath: string, remote: string, branch?: string): Promise<VcsOperationResult> {
    try {
      const args = ['git', 'remote', 'set-url', 'origin', remote];
      await jjCli.exec(args, { cwd: workspacePath });

      if (branch) {
        await jjCli.exec(['bookmark', 'set', branch], { cwd: workspacePath });
      }

      return { success: true };
    } catch (error) {
      logger.error('Failed to set upstream', { workspacePath, remote, branch, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async rebase(
    workspacePath: string,
    options: {
      target?: string;
      action?: 'continue' | 'abort' | 'skip';
    }
  ): Promise<VcsOperationResultWithConflicts> {
    try {
      if (options.action) {
        logger.warn('jj does not support rebase continue/abort/skip actions', { workspacePath, options });
        return { success: true };
      }

      if (!options.target) {
        return {
          success: false,
          error: 'Target is required for jj rebase',
        };
      }

      await jjCli.exec(['rebase', '-d', options.target], { cwd: workspacePath });
      return { success: true };
    } catch (error) {
      logger.error('Failed to rebase', { workspacePath, options, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getRebaseStatus(workspacePath: string): Promise<{
    isRebasing: boolean;
    conflicts: string[];
    currentCommit?: string;
  }> {
    try {
      const statusOutput = await jjCli.exec(['status'], { cwd: workspacePath });
      const hasConflicts = statusOutput.includes('conflict');
      const conflicts: string[] = [];

      if (hasConflicts) {
        const statusMap = this.parseStatusOutput(statusOutput);
        for (const [path, status] of Object.entries(statusMap)) {
          if (status.statusCode === 'C') {
            conflicts.push(path);
          }
        }
      }

      return {
        isRebasing: false,
        conflicts,
      };
    } catch (error) {
      logger.error('Failed to get rebase status', { workspacePath, error });
      return { isRebasing: false, conflicts: [] };
    }
  }

  async getFileDiff(
    workspacePath: string,
    args: {
      path: string;
      group: 'staged' | 'unstaged' | 'untracked' | 'conflicted' | 'working';
    }
  ): Promise<VcsFileDiff> {
    try {
      const diffOutput = await jjCli.exec(['diff', '--git', args.path], { cwd: workspacePath });

      const isBinary = diffOutput.includes('Binary files');

      return {
        unifiedDiff: diffOutput,
        isBinary,
      };
    } catch (error) {
      logger.error('Failed to get file diff', { workspacePath, args, error });
      return {
        unifiedDiff: '',
        isBinary: false,
      };
    }
  }

  async getDiff(workspacePath: string, filePath: string): Promise<string> {
    try {
      return await jjCli.exec(['diff', '--git', filePath], { cwd: workspacePath });
    } catch (error) {
      logger.error('Failed to get diff', { workspacePath, filePath, error });
      return '';
    }
  }

  async cherryPick(workspacePath: string, id: string): Promise<VcsOperationResultWithConflicts> {
    try {
      // jj duplicate creates a copy of the change without moving the original
      await jjCli.exec(['duplicate', id], { cwd: workspacePath });
      return { success: true };
    } catch (error) {
      logger.error('Failed to cherry-pick', { workspacePath, id, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async createIsolatedEnv(
    workspacePath: string,
    options?: {
      name?: string;
      baseBranch?: string;
    }
  ): Promise<VcsIsolatedEnv> {
    try {
      const name = options?.name || this.generateWorkspaceName();
      const baseBranch = options?.baseBranch || 'trunk';

      const workspaceDir = join(workspacePath, '..', `.jj-workspace-${name}`);
      await jjCli.exec(['workspace', 'add', '--name', name, workspaceDir], { cwd: workspacePath });

      const bookmarkName = `workspace/${name}`;
      await jjCli.exec(['bookmark', 'create', bookmarkName], { cwd: workspaceDir });

      return {
        id: ulid(),
        name,
        path: workspaceDir,
        branch: bookmarkName,
        baseBranch,
        projectPath: workspacePath,
        createdAt: Date.now(),
      };
    } catch (error) {
      logger.error('Failed to create isolated env', { workspacePath, options, error });
      throw error;
    }
  }

  async deleteIsolatedEnv(envPath: string, workspacePath: string): Promise<void> {
    try {
      const workspacesOutput = await jjCli.exec(['workspace', 'list'], { cwd: workspacePath });
      const lines = workspacesOutput.split('\n');

      for (const line of lines) {
        const parts = line.split(':').map((p) => p.trim());
        if (parts.length < 2) continue;
        if (parts[1] === envPath) {
          const wsName = parts[0];
          await jjCli.exec(['workspace', 'forget', wsName], { cwd: workspacePath });
          break;
        }
      }
    } catch (error) {
      logger.error('Failed to delete isolated env', { envPath, workspacePath, error });
      throw error;
    }
  }

  async listIsolatedEnvs(workspacePath: string): Promise<VcsIsolatedEnvListEntry[]> {
    try {
      const output = await jjCli.exec(['workspace', 'list'], { cwd: workspacePath });
      const lines = output.split('\n').filter((line) => line.trim());

      return lines.map((line) => {
        const parts = line.split(':').map((p) => p.trim());
        const name = parts[0] || '';
        const path = parts[1] || '';

        return {
          path,
          branch: `workspace/${name}`,
          isMain: name === 'default',
        };
      });
    } catch (error) {
      logger.error('Failed to list isolated envs', { workspacePath, error });
      return [];
    }
  }

  async getIsolatedEnvStatus(envPath: string, baseBranch?: string): Promise<VcsIsolatedEnvStatus> {
    try {
      const status = await this.getStatus(envPath);

      return {
        hasUncommittedChanges: status.hasUncommitted,
        modifiedFileCount: (await this.getUncommittedFiles(envPath)).length,
        commitsAhead: status.ahead,
        commitsBehind: status.behind,
        isMerged: false,
      };
    } catch (error) {
      logger.error('Failed to get isolated env status', { envPath, baseBranch, error });
      return {
        hasUncommittedChanges: false,
        modifiedFileCount: 0,
        commitsAhead: 0,
        commitsBehind: 0,
        isMerged: false,
      };
    }
  }

  async validateIsolatedEnv(
    envPath: string,
    _expectedBranch?: string
  ): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    if (!existsSync(envPath)) {
      issues.push('Workspace directory does not exist');
      return { valid: false, issues };
    }

    if (!existsSync(join(envPath, '.jj'))) {
      issues.push('.jj directory missing');
      return { valid: false, issues };
    }

    return { valid: issues.length === 0, issues };
  }

  async getIsolatedEnvCommits(
    envPath: string,
    baseBranch?: string
  ): Promise<Array<VcsCommit & { files: string[]; hasEquivalentOnBase?: boolean }>> {
    try {
      const base = baseBranch || 'trunk';
      const revset = `${base}..@`;

      const commits = await this.getLog(envPath, 0, { branch: revset });

      return Promise.all(
        commits.map(async (commit) => {
          const detail = await this.getCommitDetail(envPath, commit.id);
          const files = detail?.files.map((f) => f.path) || [];

          return {
            ...commit,
            files,
            hasEquivalentOnBase: false,
          };
        })
      );
    } catch (error) {
      logger.error('Failed to get isolated env commits', { envPath, baseBranch, error });
      return [];
    }
  }

  async getIsolatedEnvChangedFiles(envPath: string): Promise<Array<{ path: string; status: string }>> {
    try {
      const changes = await this.getWorkingChanges(envPath);
      return changes.unstaged;
    } catch (error) {
      logger.error('Failed to get isolated env changed files', { envPath, error });
      return [];
    }
  }

  async getIsolatedEnvFileDiff(
    envPath: string,
    filePath: string,
    baseBranch?: string
  ): Promise<{
    filePath: string;
    diff: string;
    oldContent: string;
    newContent: string;
    status: 'added' | 'modified' | 'deleted';
  }> {
    try {
      const base = baseBranch || 'trunk';
      const diff = await jjCli.exec(['diff', '--git', '-r', `${base}..@`, filePath], { cwd: envPath });

      let oldContent = '';
      let newContent = '';
      let status: 'added' | 'modified' | 'deleted' = 'modified';

      try {
        oldContent = await this.showFile(envPath, base, filePath);
      } catch {
        status = 'added';
      }

      try {
        newContent = await this.showFile(envPath, '@', filePath);
      } catch {
        status = 'deleted';
      }

      return {
        filePath,
        diff,
        oldContent,
        newContent,
        status,
      };
    } catch (error) {
      logger.error('Failed to get isolated env file diff', { envPath, filePath, baseBranch, error });
      throw error;
    }
  }

  async mergeToMain(envPath: string, mainRepoPath: string): Promise<VcsMergeResult> {
    try {
      const currentBranch = await this.getRepoCurrentBranch(envPath);

      const targetChange = await jjCli.exec(
        ['log', '-r', 'trunk()', '--no-graph', '-T', 'change_id'],
        { cwd: mainRepoPath }
      );

      await jjCli.exec(['squash', '--from', currentBranch, '--into', targetChange.trim()], { cwd: mainRepoPath });

      return {
        success: true,
        message: 'Successfully merged workspace changes to main',
      };
    } catch (error) {
      logger.error('Failed to merge to main', { envPath, mainRepoPath, error });
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async rebaseFromBase(envPath: string, baseBranch: string): Promise<VcsMergeResult> {
    try {
      await jjCli.exec(['rebase', '-d', baseBranch], { cwd: envPath });

      return {
        success: true,
        message: 'Successfully rebased from base',
      };
    } catch (error) {
      logger.error('Failed to rebase from base', { envPath, baseBranch, error });
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async squashCommits(envPath: string, commitIds: string[], message: string): Promise<string> {
    try {
      if (commitIds.length < 2) {
        throw new Error('Need at least 2 commits to squash');
      }

      const revset = commitIds.join('|');
      await jjCli.exec(['squash', '-r', revset, '-m', message], { cwd: envPath });

      const newChangeId = await jjCli.exec(
        ['log', '-r', '@', '--no-graph', '-T', 'change_id'],
        { cwd: envPath }
      );

      return newChangeId.trim();
    } catch (error) {
      logger.error('Failed to squash commits', { envPath, commitIds, error });
      throw error;
    }
  }

  async commitInEnv(envPath: string, message: string, _files?: string[]): Promise<VcsCommitResult> {
    return this.commit(envPath, message);
  }

  async stageInEnv(envPath: string, _files: string[], _stage: boolean): Promise<VcsOperationResult> {
    return { success: true };
  }

  async stageAllInEnv(_envPath: string, _stage: boolean): Promise<VcsOperationResult> {
    return { success: true };
  }

  async checkCommitsExistElsewhere(envPath: string, commitHashes: string[]): Promise<boolean> {
    try {
      const envRevset = await jjCli.exec(['log', '-r', '@', '--no-graph', '-T', 'change_id'], { cwd: envPath });

      for (const hash of commitHashes) {
        const result = await jjCli.exec(
          ['log', '-r', `${hash} & ~${envRevset.trim()}`, '--no-graph', '-T', 'change_id'],
          { cwd: envPath }
        );

        if (result.trim()) {
          return true;
        }
      }

      return false;
    } catch (error) {
      logger.error('Failed to check commits exist elsewhere', { envPath, commitHashes, error });
      return false;
    }
  }

  async getRepoCurrentBranch(repoPath: string): Promise<string> {
    try {
      const output = await jjCli.exec(['log', '-r', '@', '--no-graph', '-T', 'bookmarks'], { cwd: repoPath });
      const branch = output.trim();
      return branch || await this.getShortChangeId(repoPath);
    } catch (error) {
      logger.error('Failed to get repo current branch', { repoPath, error });
      throw error;
    }
  }

  async revParse(workspacePath: string, ref: string): Promise<string> {
    try {
      const output = await jjCli.exec(['log', '-r', ref, '--no-graph', '-T', 'commit_id'], { cwd: workspacePath });
      return output.trim();
    } catch (error) {
      logger.error('Failed to rev-parse', { workspacePath, ref, error });
      throw error;
    }
  }

  async showAtRef(workspacePath: string, ref: string, relativePath: string): Promise<string> {
    return this.showFile(workspacePath, ref, relativePath);
  }

  async statusPorcelain(workspacePath: string): Promise<string> {
    try {
      const statusOutput = await jjCli.exec(['status'], { cwd: workspacePath });
      const statusMap = this.parseStatusOutput(statusOutput);

      const lines: string[] = [];
      for (const [path, status] of Object.entries(statusMap)) {
        const code = status.statusCode || (status.status === 'modified' ? 'M' : '?');
        lines.push(`${code} ${path}`);
      }

      return lines.join('\n');
    } catch (error) {
      logger.error('Failed to get status porcelain', { workspacePath, error });
      return '';
    }
  }

  async getModifiedFilesVsBase(workspacePath: string): Promise<string[]> {
    try {
      const statusOutput = await jjCli.exec(['status'], { cwd: workspacePath });
      const statusMap = this.parseStatusOutput(statusOutput);
      return Object.keys(statusMap);
    } catch (error) {
      logger.error('Failed to get modified files vs base', { workspacePath, error });
      return [];
    }
  }

  async getWatchPaths(workspacePath: string): Promise<VcsWatchPaths | null> {
    return {
      commitWatchPaths: [join(workspacePath, '.jj', 'repo', 'op_heads')],
      indexWatchPaths: [],
    };
  }

  async getNormalizedRemote(workspacePath: string): Promise<string | null> {
    try {
      const output = await jjCli.exec(['git', 'remote', 'list'], { cwd: workspacePath });
      const lines = output.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts[0] === 'origin' && parts.length > 1) {
          return parts[1];
        }
      }

      return null;
    } catch (error) {
      logger.error('Failed to get normalized remote', { workspacePath, error });
      return null;
    }
  }

  async listIgnoredFiles(envPath: string): Promise<Array<{ path: string; isDir: boolean }>> {
    logger.warn('listIgnoredFiles not implemented for jj', { envPath });
    return [];
  }

  async cleanIgnoredFiles(envPath: string): Promise<string[]> {
    logger.warn('cleanIgnoredFiles not implemented for jj', { envPath });
    return [];
  }

  clearStatusCache(_workspacePath?: string): void {
    // No-op for jj
  }

  private parseStatusOutput(statusOutput: string): VcsFileStatusResult {
    const result: VcsFileStatusResult = {};
    const lines = statusOutput.split('\n');

    let inWorkingChanges = false;

    for (const line of lines) {
      if (line.trim() === 'Working copy changes:') {
        inWorkingChanges = true;
        continue;
      }

      if (!inWorkingChanges) continue;

      if (line.startsWith('  ')) {
        continue;
      }

      const match = line.match(/^([MADRC])\s+(.+)$/);
      if (match) {
        const [, statusCode, filePath] = match;
        let status: VcsFileStatus['status'] = 'unchanged';

        switch (statusCode) {
          case 'M':
            status = 'modified';
            break;
          case 'A':
            status = 'staged';
            break;
          case 'D':
            status = 'deleted';
            break;
          case 'R':
            status = 'modified';
            break;
          case 'C':
            status = 'modified';
            break;
        }

        result[filePath] = {
          filePath,
          status,
          statusCode,
        };
      }
    }

    return result;
  }

  private async getShortChangeId(workspacePath: string): Promise<string> {
    try {
      const output = await jjCli.exec(['log', '-r', '@', '--no-graph', '-T', 'change_id'], { cwd: workspacePath });
      return output.trim().slice(0, 12);
    } catch (error) {
      logger.error('Failed to get short change ID', { workspacePath, error });
      return '';
    }
  }

  private generateWorkspaceName(): string {
    const adjectives = [
      'swift', 'bright', 'calm', 'cool', 'warm', 'clear', 'wild', 'crisp',
      'fresh', 'misty', 'sunny', 'windy', 'frosty', 'dusty', 'hazy', 'foggy',
      'bold', 'brave', 'keen', 'wise', 'kind', 'fair', 'quick', 'clever',
      'sharp', 'neat', 'steady', 'loyal', 'humble', 'noble', 'proud', 'silent',
    ];

    const nouns = [
      'falcon', 'hawk', 'eagle', 'raven', 'owl', 'crane', 'finch', 'sparrow',
      'mountain', 'valley', 'canyon', 'glacier', 'ridge', 'cliff', 'mesa', 'dune',
      'river', 'stream', 'brook', 'creek', 'lake', 'pond', 'spring', 'bay',
      'cloud', 'storm', 'thunder', 'wind', 'star', 'moon', 'dawn', 'dusk',
    ];

    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];

    return `${adjective}-${noun}`;
  }
}
