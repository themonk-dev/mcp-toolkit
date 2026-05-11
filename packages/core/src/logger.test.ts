import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { sharedLogger } from './logger.ts';

type ConsoleMethod = 'log' | 'warn' | 'error';

interface CapturedConsole {
  log: string[];
  warn: string[];
  error: string[];
  restore: () => void;
}

function captureConsole(): CapturedConsole {
  const originals: Record<ConsoleMethod, (...args: unknown[]) => void> = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const captured: { log: string[]; warn: string[]; error: string[] } = {
    log: [],
    warn: [],
    error: [],
  };
  const replace = (key: ConsoleMethod) => {
    console[key] = ((...args: unknown[]) => {
      captured[key].push(
        args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '),
      );
    }) as typeof console.log;
  };
  replace('log');
  replace('warn');
  replace('error');
  return {
    ...captured,
    restore: () => {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}

describe('core/logger', () => {
  let cap: CapturedConsole;

  beforeEach(() => {
    cap = captureConsole();
  });

  afterEach(() => {
    cap.restore();
    sharedLogger.setLevel('info');
  });

  it('drops debug entries when current level is info but emits info+', () => {
    sharedLogger.setLevel('info');
    sharedLogger.debug('test', { message: 'should-be-dropped' });
    sharedLogger.info('test', { message: 'should-pass' });

    expect(cap.log.some((l) => l.includes('should-be-dropped'))).toBe(false);
    expect(cap.log.some((l) => l.includes('should-pass'))).toBe(true);

    // Lowering the threshold to debug now lets debug entries through.
    sharedLogger.setLevel('debug');
    sharedLogger.debug('test', { message: 'now-passes' });
    expect(cap.log.some((l) => l.includes('now-passes'))).toBe(true);
  });

  it('emits a structured payload that includes supplied context keys', () => {
    sharedLogger.setLevel('info');
    sharedLogger.info('mymodule', { message: 'hello', requestId: 'abc-123', count: 7 });

    const line = cap.log.find((l) => l.includes('hello'));
    expect(line).toBeDefined();
    expect(line).toContain('INFO');
    expect(line).toContain('[mymodule]');
    expect(line).toContain('"requestId":"abc-123"');
    expect(line).toContain('"count":7');
  });
});
