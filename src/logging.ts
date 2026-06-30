import fs from 'node:fs';
import path from 'node:path';

const STATE_DIR = path.join(process.cwd(), '.state');
const EVENTS_FILE = path.join(STATE_DIR, 'events.log');
const EXECUTED_FILE = path.join(STATE_DIR, 'executedOrders.json');

try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
} catch {
  // ignore
}

export function logEvent(type: string, payload: unknown): void {
  const entry = { ts: new Date().toISOString(), type, payload };
  try {
    fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    // best-effort
    console.error('Failed to write log event', err);
  }
}

export function loadExecuted(): Record<string, any> {
  try {
    if (!fs.existsSync(EXECUTED_FILE)) return {};
    const raw = fs.readFileSync(EXECUTED_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

export function hasExecuted(signature: string): boolean {
  const map = loadExecuted();
  return Boolean(map[signature]);
}

export function markExecuted(signature: string, info: unknown): void {
  const map = loadExecuted();
  map[signature] = { info, ts: new Date().toISOString() };
  try {
    fs.writeFileSync(EXECUTED_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to mark executed order', err);
  }
}
