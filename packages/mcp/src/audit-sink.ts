/**
 * `AuditSink` — pluggable destination for `AuditEvent`s.
 *
 * `emit` may be sync or async; the dispatcher fires-and-forgets so sinks
 * MUST NOT throw synchronously and SHOULD swallow / log their own errors
 * to avoid taking down request handling.
 *
 * `flush` is optional and used by buffered sinks at shutdown.
 */

import type { AuditEvent } from './audit-event.ts';

export interface AuditSink {
  emit(event: AuditEvent): void | Promise<void>;
  flush?(): Promise<void>;
}
