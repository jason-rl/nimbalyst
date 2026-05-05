import type {
  VcsType,
  VcsTerminology,
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
} from './types';

export interface VcsProvider {
  readonly type: VcsType;
  readonly terminology: VcsTerminology;

  // --- Detection & availability ---
  isAvailable(): boolean;
  isRepository(workspacePath: string): Promise<boolean>;
  isIsolatedEnv(workspacePath: string): Promise<boolean>;

  // --- Status ---
  getStatus(workspacePath: string): Promise<VcsStatus>;
  getFileStatuses(workspacePath: string, filePaths: string[]): Promise<VcsFileStatusResult>;
  getAllFileStatuses(workspacePath: string): Promise<VcsFileStatusResult>;
  getUncommittedFiles(workspacePath: string): Promise<string[]>;
  getWorkingChanges(workspacePath: string): Promise<VcsWorkingChanges>;
  getRepoState(workspacePath: string): Promise<VcsRepoState>;

  // --- Log & history ---
  getLog(workspacePath: string, limit: number, options?: {
    branch?: string;
    author?: string;
    since?: string;
    until?: string;
  }): Promise<VcsCommit[]>;
  getCommitDetail(workspacePath: string, id: string): Promise<VcsCommitDetail | null>;
  showFile(workspacePath: string, ref: string, filePath: string): Promise<string>;

  // --- Branches/Bookmarks ---
  getBranches(workspacePath: string): Promise<VcsBranchInfo>;
  createBranch(workspacePath: string, name: string, fromRef: string): Promise<VcsOperationResult>;
  checkout(workspacePath: string, ref: string): Promise<VcsOperationResult>;

  // --- Staging ---
  stageFiles(workspacePath: string, files: string[]): Promise<VcsOperationResult>;
  unstageFiles(workspacePath: string, files: string[]): Promise<VcsOperationResult>;
  discardChanges(workspacePath: string, files: string[]): Promise<VcsOperationResult>;

  // --- Commit ---
  commit(workspacePath: string, message: string, filesToStage?: string[]): Promise<VcsCommitResult>;

  // --- Remote operations ---
  push(workspacePath: string, options?: {
    force?: boolean;
    setUpstream?: boolean;
    remote?: string;
    branch?: string;
  }): Promise<VcsOperationResult>;
  pull(workspacePath: string, options?: {
    rebase?: boolean;
    ffOnly?: boolean;
  }): Promise<VcsOperationResultWithConflicts>;
  fetch(workspacePath: string, options?: {
    remote?: string;
  }): Promise<VcsOperationResult>;
  setUpstream(workspacePath: string, remote: string, branch?: string): Promise<VcsOperationResult>;

  // --- Rebase ---
  rebase(workspacePath: string, options: {
    target?: string;
    action?: 'continue' | 'abort' | 'skip';
  }): Promise<VcsOperationResultWithConflicts>;
  getRebaseStatus(workspacePath: string): Promise<{
    isRebasing: boolean;
    conflicts: string[];
    currentCommit?: string;
  }>;

  // --- Diff ---
  getFileDiff(workspacePath: string, args: {
    path: string;
    group: 'staged' | 'unstaged' | 'untracked' | 'conflicted' | 'working';
  }): Promise<VcsFileDiff>;
  getDiff(workspacePath: string, filePath: string): Promise<string>;

  // --- Cherry-pick ---
  cherryPick(workspacePath: string, id: string): Promise<VcsOperationResultWithConflicts>;

  // --- Isolated environments (worktree / workspace) ---
  createIsolatedEnv(workspacePath: string, options?: {
    name?: string;
    baseBranch?: string;
  }): Promise<VcsIsolatedEnv>;
  deleteIsolatedEnv(envPath: string, workspacePath: string): Promise<void>;
  listIsolatedEnvs(workspacePath: string): Promise<VcsIsolatedEnvListEntry[]>;
  getIsolatedEnvStatus(envPath: string, baseBranch?: string): Promise<VcsIsolatedEnvStatus>;
  validateIsolatedEnv(envPath: string, expectedBranch?: string): Promise<{ valid: boolean; issues: string[] }>;
  getIsolatedEnvCommits(envPath: string, baseBranch?: string): Promise<Array<VcsCommit & { files: string[]; hasEquivalentOnBase?: boolean }>>;
  getIsolatedEnvChangedFiles(envPath: string): Promise<Array<{ path: string; status: string }>>;
  getIsolatedEnvFileDiff(envPath: string, filePath: string, baseBranch?: string): Promise<{
    filePath: string;
    diff: string;
    oldContent: string;
    newContent: string;
    status: 'added' | 'modified' | 'deleted';
  }>;
  mergeToMain(envPath: string, mainRepoPath: string): Promise<VcsMergeResult>;
  rebaseFromBase(envPath: string, baseBranch: string): Promise<VcsMergeResult>;
  squashCommits(envPath: string, commitIds: string[], message: string): Promise<string>;
  commitInEnv(envPath: string, message: string, files?: string[]): Promise<VcsCommitResult>;
  stageInEnv(envPath: string, files: string[], stage: boolean): Promise<VcsOperationResult>;
  stageAllInEnv(envPath: string, stage: boolean): Promise<VcsOperationResult>;
  checkCommitsExistElsewhere(envPath: string, commitHashes: string[]): Promise<boolean>;
  getRepoCurrentBranch(repoPath: string): Promise<string>;

  // --- File snapshot support ---
  revParse(workspacePath: string, ref: string): Promise<string>;
  showAtRef(workspacePath: string, ref: string, relativePath: string): Promise<string>;
  statusPorcelain(workspacePath: string): Promise<string>;
  getModifiedFilesVsBase(workspacePath: string): Promise<string[]>;

  // --- Watch paths ---
  getWatchPaths(workspacePath: string): Promise<VcsWatchPaths | null>;

  // --- Remote info ---
  getNormalizedRemote(workspacePath: string): Promise<string | null>;

  // --- Gitignored files ---
  listIgnoredFiles(envPath: string): Promise<Array<{ path: string; isDir: boolean }>>;
  cleanIgnoredFiles(envPath: string): Promise<string[]>;

  // --- Status cache ---
  clearStatusCache(workspacePath?: string): void;
}
