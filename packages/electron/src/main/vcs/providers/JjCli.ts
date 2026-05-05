import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import log from 'electron-log/main';

const execFileAsync = promisify(execFile);
const logger = log.scope('JjCli');

let cachedAvailability: boolean | null = null;

export class JjCli {
  isAvailable(): boolean {
    if (cachedAvailability !== null) {
      return cachedAvailability;
    }

    try {
      execFileSync('jj', ['version'], { stdio: 'pipe', timeout: 5000 });
      cachedAvailability = true;
      logger.info('jj CLI is available');
      return true;
    } catch (error) {
      cachedAvailability = false;
      logger.warn('jj CLI is not available in PATH', { error });
      return false;
    }
  }

  async exec(args: string[], opts?: { cwd?: string; timeout?: number }): Promise<string> {
    const timeout = opts?.timeout ?? 10000;
    const cwd = opts?.cwd;

    const fullArgs = [
      '--no-pager',
      '--color=never',
      '--config-toml',
      'ui.paginate="never"',
      ...args,
    ];

    logger.debug('Executing jj command', { args: fullArgs, cwd });

    try {
      const { stdout } = await execFileAsync('jj', fullArgs, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });

      return stdout.trim();
    } catch (error) {
      logger.error('jj command failed', {
        args: fullArgs,
        cwd,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
