import type { SourceConnector, SourceRecord } from '@relate/runtime';

/** The development CRM explicitly distinguishes deletion from access denial. */
export function crmConnector(baseUrl: string): SourceConnector {
  return {
    async fetch(sourceRecordId, { signal }): Promise<SourceRecord> {
      const response = await fetch(
        `${baseUrl}/customers/${encodeURIComponent(sourceRecordId)}`,
        { signal },
      );

      if (!response.ok) throw new Error('CRM unavailable');

      return (await response.json()) as SourceRecord;
    },
  };
}
