export type VcsType = 'git' | 'jj';

export interface VcsTerminology {
  vcsName: string;
  branch: string;
  branches: string;
  worktree: string;
  worktrees: string;
  commit: string;
  commits: string;
  commitId: string;
  staging: string;
  stageAction: string;
  hasStaging: boolean;
}

export const GIT_TERMINOLOGY: VcsTerminology = {
  vcsName: 'Git',
  branch: 'branch',
  branches: 'branches',
  worktree: 'worktree',
  worktrees: 'worktrees',
  commit: 'commit',
  commits: 'commits',
  commitId: 'hash',
  staging: 'staging area',
  stageAction: 'stage',
  hasStaging: true,
};

export const JJ_TERMINOLOGY: VcsTerminology = {
  vcsName: 'Jujutsu',
  branch: 'bookmark',
  branches: 'bookmarks',
  worktree: 'workspace',
  worktrees: 'workspaces',
  commit: 'change',
  commits: 'changes',
  commitId: 'change ID',
  staging: 'working copy',
  stageAction: 'track',
  hasStaging: false,
};

export interface VcsInfo {
  type: VcsType;
  terminology: VcsTerminology;
}
