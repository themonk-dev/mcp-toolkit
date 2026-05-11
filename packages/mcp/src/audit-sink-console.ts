import type { AuditEvent } from './audit-event.ts';
import type { AuditSink } from './audit-sink.ts';

/**
 * NDJSON sink. One JSON line per event via `console.log`. Workers-safe
 * (no `node:*`). Fire-and-forget; no buffering, no flush needed.
 */
export class ConsoleAuditSink implements AuditSink {
  emit(event: AuditEvent): void {
    console.log(JSON.stringify(event));
  }
}
