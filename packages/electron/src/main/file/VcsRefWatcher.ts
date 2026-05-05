import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { clearGitStatusCache } from '../ipc/GitStatusHandlers';
import { getVcsProvider } from '../vcs/VcsProviderFactory';
import type { VcsProvider } from '../vcs/VcsProvider';
import type { VcsType } from '../vcs/types';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const logger = log.scope('VcsRefWatcher');

interface WatcherEntry {
  commitWatcher: FSWatcher | null;
  indexWatcher: FSWatcher | null;
  lastCommitHash: string;
  currentBranch: string;
  vcsType: VcsType;
  provider: VcsProvider;
}

export interface CommitDetectedEvent {
  workspacePath: string;
  commitHash: string;
  commitMessage: string;
  committedFiles: string[];
}

export type CommitDetectedListener = (event: CommitDetectedEvent) => void | Promise<void>;

export class VcsRefWatcher {
  private watchers = new Map<string, WatcherEntry>();

  private indexDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly INDEX_DEBOUNCE_MS = 100;

  private commitListeners = new Set<CommitDetectedListener>();

  onCommitDetected(listener: CommitDetectedListener): void {
    this.commitListeners.add(listener);
  }

  offCommitDetected(listener: CommitDetectedListener): void {
    this.commitListeners.delete(listener);
  }

  async start(workspacePath: string): Promise<void> {
    if (this.watchers.has(workspacePath)) {
      logger.debug('Already watching workspace:', path.basename(workspacePath));
      return;
    }

    try {
      const provider = getVcsProvider(workspacePath);
      if (!provider) {
        logger.debug('Not a VCS repository:', path.basename(workspacePath));
        return;
      }

      const watchPaths = await provider.getWatchPaths(workspacePath);
      if (!watchPaths) {
        logger.debug('No watch paths returned for workspace:', path.basename(workspacePath));
        return;
      }

      const status = await provider.getStatus(workspacePath);
      const currentBranch = status.branch;
      if (!currentBranch) {
        logger.info('Skipping workspace without current branch:', workspacePath);
        return;
      }

      let lastCommitHash = '';
      try {
        lastCommitHash = await provider.revParse(workspacePath, provider.type === 'jj' ? '@' : 'HEAD');
      } catch (error) {
        logger.warn('Could not get current commit hash:', error);
      }

      let commitWatcher: FSWatcher | null = null;
      if (watchPaths.commitWatchPaths.length > 0) {
        commitWatcher = chokidar.watch(watchPaths.commitWatchPaths, {
          ignoreInitial: true,
          persistent: true,
          usePolling: false,
          awaitWriteFinish: {
            stabilityThreshold: 50,
            pollInterval: 10,
          },
        });

        commitWatcher.on('change', async () => {
          logger.info('Commit path changed:', {
            workspace: path.basename(workspacePath),
            branch: currentBranch,
            vcsType: provider.type,
          });
          await this.handleCommitChange(workspacePath);
        });

        commitWatcher.on('add', async () => {
          logger.info('Commit path added:', {
            workspace: path.basename(workspacePath),
            branch: currentBranch,
            vcsType: provider.type,
          });
          await this.handleCommitChange(workspacePath);
        });

        commitWatcher.on('unlink', async () => {
          logger.info('Commit path unlinked:', {
            workspace: path.basename(workspacePath),
            branch: currentBranch,
            vcsType: provider.type,
          });
          await this.handleCommitChange(workspacePath);
        });

        commitWatcher.on('error', (error) => {
          logger.error('Commit watcher error:', error);
        });
      }

      let indexWatcher: FSWatcher | null = null;
      if (watchPaths.indexWatchPaths.length > 0) {
        indexWatcher = chokidar.watch(watchPaths.indexWatchPaths, {
          ignoreInitial: true,
          persistent: true,
          usePolling: false,
          awaitWriteFinish: {
            stabilityThreshold: 50,
            pollInterval: 10,
          },
        });

        indexWatcher.on('change', () => {
          this.handleIndexChangeDebounced(workspacePath);
        });

        indexWatcher.on('error', (error) => {
          logger.error('Index watcher error:', error);
        });
      }

      this.watchers.set(workspacePath, {
        commitWatcher,
        indexWatcher,
        lastCommitHash,
        currentBranch,
        vcsType: provider.type,
        provider,
      });

      logger.info('Started watching:', {
        workspace: path.basename(workspacePath),
        branch: currentBranch,
        vcsType: provider.type,
        commitPaths: watchPaths.commitWatchPaths.length,
        indexPaths: watchPaths.indexWatchPaths.length,
      });
    } catch (error) {
      logger.error('Failed to start watching:', error);
    }
  }

  async stop(workspacePath: string): Promise<void> {
    const entry = this.watchers.get(workspacePath);
    if (entry) {
      if (entry.commitWatcher) {
        await entry.commitWatcher.close();
      }
      if (entry.indexWatcher) {
        await entry.indexWatcher.close();
      }
      this.watchers.delete(workspacePath);

      const timer = this.indexDebounceTimers.get(workspacePath);
      if (timer) {
        clearTimeout(timer);
        this.indexDebounceTimers.delete(workspacePath);
      }

      logger.info('Stopped watching:', path.basename(workspacePath));
    }
  }

  async stopAll(): Promise<void> {
    logger.info(`Stopping all watchers (${this.watchers.size} active)`);

    const promises: Promise<void>[] = [];
    for (const workspacePath of this.watchers.keys()) {
      promises.push(this.stop(workspacePath));
    }
    await Promise.all(promises);

    logger.info('All watchers stopped');
  }

  private async handleCommitChange(workspacePath: string): Promise<void> {
    try {
      const entry = this.watchers.get(workspacePath);
      if (!entry) return;

      const { vcsType, provider } = entry;

      let newCommitHash: string;
      let commitMessage: string;
      let committedFiles: string[] = [];

      if (vcsType === 'git') {
        try {
          newCommitHash = await provider.revParse(workspacePath, 'HEAD');
        } catch (error) {
          logger.error('Failed to get git commit hash:', error);
          return;
        }

        if (!newCommitHash || entry.lastCommitHash === newCommitHash) {
          return;
        }

        const commits = await provider.getLog(workspacePath, 1);
        if (!commits[0]) return;

        commitMessage = commits[0].message;

        try {
          const oldCommitHash = entry.lastCommitHash;
          const commitDetail = await provider.getCommitDetail(workspacePath, newCommitHash);
          if (commitDetail) {
            committedFiles = commitDetail.files.map((file) =>
              path.join(workspacePath, file.path)
            );
          }
        } catch (diffError) {
          logger.warn('Could not get diff summary, skipping auto-approve', diffError);
        }
      } else if (vcsType === 'jj') {
        try {
          newCommitHash = await provider.revParse(workspacePath, '@');
        } catch (error) {
          logger.error('Failed to get jj commit ID:', error);
          return;
        }

        if (!newCommitHash || entry.lastCommitHash === newCommitHash) {
          return;
        }

        try {
          const commits = await provider.getLog(workspacePath, 1);
          commitMessage = commits[0]?.message || '';
        } catch (error) {
          logger.error('Failed to get jj commit message:', error);
          commitMessage = '';
        }

        try {
          const commitDetail = await provider.getCommitDetail(workspacePath, newCommitHash);
          if (commitDetail) {
            committedFiles = commitDetail.files.map((file) =>
              path.join(workspacePath, file.path)
            );
          }
        } catch (error) {
          logger.warn('Could not get jj diff summary:', error);
        }
      } else {
        return;
      }

      logger.info('New commit detected:', {
        workspace: path.basename(workspacePath),
        hash: newCommitHash.slice(0, 7),
        message: commitMessage?.substring(0, 50),
        vcsType,
      });

      entry.lastCommitHash = newCommitHash;

      if (committedFiles.length > 0) {
        await this.autoApprovePendingReviews(workspacePath, committedFiles);
      }

      clearGitStatusCache(workspacePath);

      const commitEvent: CommitDetectedEvent = {
        workspacePath,
        commitHash: newCommitHash,
        commitMessage,
        committedFiles,
      };
      for (const listener of this.commitListeners) {
        try {
          Promise.resolve(listener(commitEvent)).catch((err) => {
            logger.error('Commit listener error:', err);
          });
        } catch (err) {
          logger.error('Commit listener error:', err);
        }
      }

      this.emitToAllWindows('git:commit-detected', commitEvent);

      this.emitToAllWindows('git:status-changed', {
        workspacePath,
      });
    } catch (error) {
      logger.error('Error handling commit change:', error);
    }
  }

  private handleIndexChangeDebounced(workspacePath: string): void {
    const existingTimer = this.indexDebounceTimers.get(workspacePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.indexDebounceTimers.delete(workspacePath);
      this.handleIndexChange(workspacePath);
    }, this.INDEX_DEBOUNCE_MS);

    this.indexDebounceTimers.set(workspacePath, timer);
  }

  private handleIndexChange(workspacePath: string): void {
    clearGitStatusCache(workspacePath);

    this.emitToAllWindows('git:status-changed', {
      workspacePath,
    });
  }

  private async autoApprovePendingReviews(
    workspacePath: string,
    committedFiles: string[]
  ): Promise<void> {
    try {
      const { historyManager } = await import('../HistoryManager');

      let approvedCount = 0;
      for (const filePath of committedFiles) {
        const pendingTags = await historyManager.getPendingTags(filePath);

        logger.debug('Checking file for pending tags:', {
          file: path.basename(filePath),
          fullPath: filePath,
          pendingTagCount: pendingTags.length,
        });

        if (pendingTags.length > 0) {
          for (const tag of pendingTags) {
            await historyManager.updateTagStatus(filePath, tag.id, 'reviewed', workspacePath);
            approvedCount++;
          }
        }
      }

      if (approvedCount > 0) {
        logger.info('Auto-approved pending reviews:', {
          workspace: path.basename(workspacePath),
          count: approvedCount,
        });

        const count = await historyManager.getPendingCount(workspacePath);
        this.emitToAllWindows('history:pending-count-changed', {
          workspacePath,
          count,
        });
      } else {
        logger.info('No pending reviews found for committed files');
      }
    } catch (error) {
      logger.error('Error auto-approving pending reviews:', error);
    }
  }

  private emitToAllWindows(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data);
      }
    }
  }

  getStats(): { type: string; activeWatchers: number; workspaces: string[] } {
    return {
      type: 'VcsRefWatcher',
      activeWatchers: this.watchers.size,
      workspaces: Array.from(this.watchers.keys()).map((p) => path.basename(p)),
    };
  }
}

export const vcsRefWatcher = new VcsRefWatcher();
