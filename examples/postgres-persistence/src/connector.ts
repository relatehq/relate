import { SourceAccessDenied } from '@relate/runtime';
import type { SourceConnector, SourceRecord } from '@relate/runtime';

/**
 * The development CRM distinguishes three outcomes the runtime treats
 * differently: a deleted record (`state: 'deleted'`), explicit permission
 * denial (HTTP 403, `SourceAccessDenied`, no fallback), and any other failure
 * (temporary unavailability with authorized stale fallback).
 */
export function crmConnector(baseUrl: string): SourceConnector {
  return {
    async fetch(sourceRecordId, { signal }): Promise<SourceRecord> {
      const response = await fetch(
        `${baseUrl}/customers/${encodeURIComponent(sourceRecordId)}`,
        { signal },
      );

      if (response.status === 403) throw new SourceAccessDenied();

      if (!response.ok) throw new Error('CRM unavailable');

      return (await response.json()) as SourceRecord;
    },
  };
}
