import type { Logger } from './types.js';

const PREFIX = '[image-upscaler]';

/**
 * Default logger.
 *
 * Debug output is off unless the host opts in, because a library that chatters
 * into a consumer's console is a library people stop using. Warnings and
 * errors always go through: they describe things the consumer can act on
 * (a GPU that dropped out, a model that would not cache).
 */
export function createLogger(verbose = detectVerbose()): Logger {
  return {
    debug(message, ...args) {
      if (!verbose) return;
      // eslint-disable-next-line no-console
      console.debug(`${PREFIX} ${message}`, ...args);
    },
    warn(message, ...args) {
      // eslint-disable-next-line no-console
      console.warn(`${PREFIX} ${message}`, ...args);
    },
    error(message, ...args) {
      // eslint-disable-next-line no-console
      console.error(`${PREFIX} ${message}`, ...args);
    },
  };
}

/** `localStorage.setItem('image-upscaler:debug', '1')` turns debug on. */
function detectVerbose(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' && localStorage.getItem('image-upscaler:debug') === '1'
    );
  } catch {
    // Storage access throws in some sandboxed iframes.
    return false;
  }
}

export const silentLogger: Logger = {
  debug() {},
  warn() {},
  error() {},
};
