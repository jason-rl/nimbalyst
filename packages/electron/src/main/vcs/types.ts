export type { VcsType, VcsTerminology, VcsInfo } from '../../shared/vcs/types';
export { GIT_TERMINOLOGY, JJ_TERMINOLOGY } from '../../shared/vcs/types';

export interface VcsStatus {
  branch: string;
  ahead: number;
  behind: number;
  hasUncommitted: boolean;
  baseBranch?: string;
  isMerged?: boolean;
}

export interface VcsCommit {
  id: string;
  shortId: string;
  contentHash?: string;
  message: string;
  author: string;
  date: string;
  refs?: string;
}

export interface VcsFileStatus {
  filePath: string;
  status: 'modified' | 'staged' | 'untracked' | 'unchanged' | 'deleted';
  statusCode?: string;
}

export interface VcsFileStatusResult {
  [filePath: string]: VcsFileStatus;
}

export interface VcsWorkingChanges {
  staged: Array<{ path: string; status: string }>;
  unstaged: Array<{ path: string; status: string }>;
  untracked: Array<{ path: string }>;
  conflicted: Array<{ path: string }>;
}

export interface VcsBranchInfo {
  branches: string[];
  current: string;
}

export interface VcsCommitDetail {
  body: string;
  files: Array<{ status: string; path: string; added: number; deleted: number }>;
  summary: { filesChanged: number; insertions: number; deletions: number };
}

export interface VcsFileDiff {
  unifiedDiff: string;
  isBinary: boolean;
  truncated?: boolean;
}

export interface VcsRepoState {
  isClean: boolean;
  inMerge: boolean;
  inRebase: boolean;
  inCherryPick: boolean;
  inRevert: boolean;
  conflictedFiles: string[];
}

export interface VcsIsolatedEnv {
  id: string;
  name: string;
  path: string;
  branch: string;
  baseBranch: string;
  projectPath: string;
  createdAt: number;
}

export interface VcsIsolatedEnvStatus {
  hasUncommittedChanges: boolean;
  modifiedFileCount: number;
  commitsAhead: number;
  commitsBehind: number;
  isMerged: boolean;
  uniqueCommitsAhead?: number;
}

export interface VcsIsolatedEnvListEntry {
  path: string;
  branch: string;
  isMain: boolean;
}

export interface VcsMergeResult {
  success: boolean;
  message: string;
  conflictedFiles?: string[];
  stashWarning?: boolean;
}

export interface VcsCommitResult {
  success: boolean;
  commitHash?: string;
  commitDate?: string;
  error?: string;
}

export interface VcsOperationResult {
  success: boolean;
  error?: string;
}

export interface VcsOperationResultWithConflicts extends VcsOperationResult {
  conflicts?: string[];
}

export interface VcsWatchPaths {
  commitWatchPaths: string[];
  indexWatchPaths: string[];
}
