#!/usr/bin/env node
import { loadConfig } from './config/config.js';
import { Engine, parseCliArgs } from './core/engine.js';
import { flushLogger, getLogger } from './util/logger.js';

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const config = loadConfig({
    mode: cli.mode,
    tagIds: cli.tagIds,
    eventSlugs: cli.eventSlugs,
    confirmLive: cli.confirmLive,
  });

  // The Engine constructor calls initLogger() itself; grab the logger after
  // constructing it instead of initializing twice (a second init would open
  // a second file handle on the same log file and orphan the first one).
  const engine = new Engine(config);
  const log = getLogger();

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down');
    await engine.stop();
    await flushLogger();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await engine.start();
  } catch (error) {
    log.error({ error }, 'Fatal engine error');
    await flushLogger();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
