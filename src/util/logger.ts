import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino from 'pino';
import type { Config } from '../config/types.js';

let loggerInstance: pino.Logger | null = null;
let loggerDestination: pino.DestinationStream | null = null;

export function initLogger(config: Config): pino.Logger {
  // Idempotent: callers (index.ts + the Engine constructor) may both request
  // init. Re-creating the destination here would open a second file handle
  // on the same log file and orphan the first one.
  if (loggerInstance) return loggerInstance;

  mkdirSync(dirname(config.logFile), { recursive: true });
  const destination = pino.destination({ dest: config.logFile, sync: false });
  loggerDestination = destination;
  loggerInstance = pino(
    {
      level: config.logLevel,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
  return loggerInstance;
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    loggerInstance = pino({ level: 'info' });
  }
  return loggerInstance;
}

/**
 * Waits for the log file destination to finish opening (if it hasn't yet)
 * and flushes any buffered writes. Since the destination is async
 * (`sync: false`), calling `process.exit()` right after logging can race
 * ahead of the file open completing; pino's own exit handler then calls
 * `SonicBoom.flushSync()`, which throws "sonic boom is not ready yet" and
 * silently drops whatever was buffered (including the message you just
 * logged). Await this before any `process.exit()` call to avoid that.
 */
export function flushLogger(): Promise<void> {
  const destination = loggerDestination as (pino.DestinationStream & {
    fd?: number;
    destroyed?: boolean;
    flush?: (cb: (err?: Error) => void) => void;
    once?: (event: string, cb: () => void) => void;
  }) | null;

  if (!destination || destination.destroyed) return Promise.resolve();

  return new Promise((resolve) => {
    const doFlush = () => {
      if (typeof destination.flush === 'function') {
        destination.flush(() => resolve());
      } else {
        resolve();
      }
    };
    if ((destination.fd ?? -1) >= 0) {
      doFlush();
    } else if (typeof destination.once === 'function') {
      destination.once('ready', doFlush);
    } else {
      resolve();
    }
  });
}
