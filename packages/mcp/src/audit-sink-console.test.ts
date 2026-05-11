import { describe, expect, it, spyOn } from 'bun:test';
import type { AuditCatalogListEvent, AuditToolCallEvent } from './audit-event.ts';
import { ConsoleAuditSink } from './audit-sink-console.ts';

describe('mcp/ConsoleAuditSink', () => {
  it('emits one valid JSON line per event with kind/timestamp/sessionId', () => {
    const sink = new ConsoleAuditSink();
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const toolCall: AuditToolCallEvent = {
        kind: 'mcp.tool.call',
        timestamp: '2026-05-11T00:00:00.000Z',
        sessionId: 'sess-1',
        tool: 'echo',
        outcome: 'ok',
      };
      const catalog: AuditCatalogListEvent = {
        kind: 'mcp.catalog.list',
        timestamp: '2026-05-11T00:00:01.000Z',
        sessionId: 'sess-2',
        methods: ['tools/list'],
      };
      sink.emit(toolCall);
      sink.emit(catalog);
      expect(logSpy).toHaveBeenCalledTimes(2);
      const [line1, line2] = logSpy.mock.calls.map((c) => c[0] as string);
      const parsed1 = JSON.parse(line1);
      const parsed2 = JSON.parse(line2);
      expect(parsed1).toMatchObject({
        kind: 'mcp.tool.call',
        timestamp: '2026-05-11T00:00:00.000Z',
        sessionId: 'sess-1',
      });
      expect(parsed2).toMatchObject({
        kind: 'mcp.catalog.list',
        timestamp: '2026-05-11T00:00:01.000Z',
        sessionId: 'sess-2',
      });
      expect(line1.split('\n')).toHaveLength(1);
      expect(line2.split('\n')).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not throw on unknown extra fields', () => {
    const sink = new ConsoleAuditSink();
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const event = {
        kind: 'mcp.tool.call',
        timestamp: '2026-05-11T00:00:00.000Z',
        sessionId: 'sess-x',
        tool: 'echo',
        outcome: 'ok',
        unexpectedField: { nested: 'value' },
      } as unknown as AuditToolCallEvent;
      expect(() => sink.emit(event)).not.toThrow();
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed.unexpectedField).toEqual({ nested: 'value' });
    } finally {
      logSpy.mockRestore();
    }
  });
});
