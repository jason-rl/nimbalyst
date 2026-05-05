import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';
import { getVcsProvider } from '../vcs/VcsProviderFactory';
import type { VcsProvider } from '../vcs/VcsProvider';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.flac',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.sqlite', '.db', '.lock',
  '.wasm', '.node',
  // Electron/packaged-app bundle artifacts — caching these blew up memory when
  // release-smoke-backup-marker/ was accidentally dropped into the workspace.
  '.pak', '.pdb', '.dat', '.bin', '.blockmap', '.asar', '.icns', '.appimage',
  '.dmg', '.deb', '.rpm', '.snap', '.msi', '.nupkg',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.jj', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.svelte-kit', 'worktrees',
  '.vscode', '.idea', 'target', '.DS_Store',
]);

const MAX_FILE_SIZE = 1_000_000; // 1MB
const MAX_CACHE_BYTES = 100_000_000; // 100MB memory cap
const MAX_DIRTY_FILES = 200; // Cap upfront file reads to avoid I/O storms from large dirty sets
const MAX_FULL_SCAN_FILES = 500; // Higher cap for non-git repos (no git fallback available)

export class FileSnapshotCache {
  private cache = new Map<string, string>();
  private totalBytes = 0;
  private workspacePath: string | null = null;
  private sessionId: string | null = null;
  private isVcsRepo = false;
  private vcsProvider: VcsProvider | null = null;
  private startSha: string | null = null;

  async startSession(workspacePath: string, sessionId: string): Promise<void> {
    this.stopSession();
    this.workspacePath = workspacePath;
    this.sessionId = sessionId;

    this.vcsProvider = getVcsProvider(workspacePath);
    this.isVcsRepo = this.vcsProvider !== null;

    if (this.isVcsRepo && this.vcsProvider) {
      await this.initVcsCache(workspacePath);
    } else {
      await this.initFullScan(workspacePath);
    }

    // logger.main.info('[FileSnapshotCache] Session started', this.getStats());
  }

  stopSession(): void {
    this.cache.clear();
    this.totalBytes = 0;
    this.workspacePath = null;
    this.sessionId = null;
    this.isVcsRepo = false;
    this.vcsProvider = null;
    this.startSha = null;
  }

  async getBeforeState(filePath: string): Promise<string | null> {
    // Tier 1: in-memory cache
    const cached = this.cache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    // Tier 2: VCS on-demand
    if (this.isVcsRepo && this.vcsProvider && this.startSha && this.workspacePath) {
      try {
        const resolved = await this.resolveRelativePathInWorkspace(filePath);
        if (!resolved) return null;

        const content = await this.vcsProvider.showAtRef(resolved.workspacePath, this.startSha, resolved.relativePath);
        this.addToCache(filePath, content);
        return content;
      } catch {
        return null;
      }
    }

    return null;
  }

  updateSnapshot(filePath: string, content: string): void {
    this.addToCache(filePath, content);
  }

  removeSnapshot(filePath: string): void {
    const existing = this.cache.get(filePath);
    if (existing !== undefined) {
      this.totalBytes -= Buffer.byteLength(existing, 'utf-8');
      this.cache.delete(filePath);
    }
  }

  getStats(): { fileCount: number; totalBytes: number; sessionId: string | null; isGitRepo: boolean } {
    return {
      fileCount: this.cache.size,
      totalBytes: this.totalBytes,
      sessionId: this.sessionId,
      isGitRepo: this.isVcsRepo,
    };
  }

  private addToCache(filePath: string, content: string): void {
    // Remove old entry size if replacing
    const existing = this.cache.get(filePath);
    if (existing !== undefined) {
      this.totalBytes -= Buffer.byteLength(existing, 'utf-8');
    }

    const byteLen = Buffer.byteLength(content, 'utf-8');

    // Enforce memory cap - skip caching if over limit (git fallback still works)
    if (this.totalBytes + byteLen > MAX_CACHE_BYTES && existing === undefined) {
      logger.main.warn('[FileSnapshotCache] Memory cap reached, skipping cache for:', filePath);
      return;
    }

    this.cache.set(filePath, content);
    this.totalBytes += byteLen;
  }

  private async initVcsCache(workspacePath: string): Promise<void> {
    if (!this.vcsProvider) return;

    try {
      const ref = this.vcsProvider.type === 'jj' ? '@' : 'HEAD';
      this.startSha = await this.vcsProvider.revParse(workspacePath, ref);
    } catch {
      this.startSha = null;
      logger.main.warn('[FileSnapshotCache] No commits in repo, treating as non-VCS for caching');
      await this.initFullScan(workspacePath);
      return;
    }

    try {
      const uncommitted = await this.vcsProvider.getUncommittedFiles(workspacePath);
      const dirtyFiles = new Set(uncommitted);

      if (dirtyFiles.size > MAX_DIRTY_FILES) {
        logger.main.warn(`[FileSnapshotCache] ${dirtyFiles.size} dirty files exceeds limit of ${MAX_DIRTY_FILES}, caching only first ${MAX_DIRTY_FILES} (rest use VCS fallback)`);
      }

      let cached = 0;
      for (const relativePath of dirtyFiles) {
        if (cached >= MAX_DIRTY_FILES) break;

        const absPath = path.resolve(workspacePath, relativePath);
        if (this.isBinaryPath(absPath)) continue;

        try {
          const content = await this.readFileIfEligible(absPath);
          if (content !== null) {
            this.addToCache(absPath, content);
            cached++;
          }
        } catch {
          // Skip files that can't be read
        }
      }
    } catch (error) {
      logger.main.error('[FileSnapshotCache] Failed to scan dirty files:', error);
    }
  }

  private async initFullScan(workspacePath: string): Promise<void> {
    try {
      await this.walkAndCache(workspacePath, workspacePath);
    } catch (error) {
      logger.main.error('[FileSnapshotCache] Full scan failed:', error);
    }
  }

  private async walkAndCache(dir: string, rootPath: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.walkAndCache(fullPath, rootPath);
      } else if (entry.isFile()) {
        if (this.isBinaryPath(fullPath)) continue;
        if (this.cache.size >= MAX_FULL_SCAN_FILES || this.totalBytes >= MAX_CACHE_BYTES) break;

        const content = await this.readFileIfEligible(fullPath);
        if (content !== null) {
          this.addToCache(fullPath, content);
        }
      }
    }
  }

  private async readFileIfEligible(filePath: string): Promise<string | null> {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_SIZE) return null;

      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Resolve file path to a safe, workspace-relative path.
   *
   * Primary path uses raw workspace/file strings.
   * Fallback handles symlink/casing differences by comparing canonical realpaths.
   */
  private async resolveRelativePathInWorkspace(
    filePath: string
  ): Promise<{ workspacePath: string; relativePath: string } | null> {
    if (!this.workspacePath) return null;

    const directRelative = path.relative(this.workspacePath, filePath);
    if (this.isRelativeInsideWorkspace(directRelative)) {
      return { workspacePath: this.workspacePath, relativePath: directRelative };
    }

    try {
      const [realWorkspacePath, realFilePath] = await Promise.all([
        fs.realpath(this.workspacePath),
        fs.realpath(filePath),
      ]);
      const canonicalRelative = path.relative(realWorkspacePath, realFilePath);
      if (!this.isRelativeInsideWorkspace(canonicalRelative)) {
        return null;
      }
      return { workspacePath: realWorkspacePath, relativePath: canonicalRelative };
    } catch {
      return null;
    }
  }

  private isRelativeInsideWorkspace(relativePath: string): boolean {
    return !!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
  }

  private isBinaryPath(filePath: string): boolean {
    return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }
}
