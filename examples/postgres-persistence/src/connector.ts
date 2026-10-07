import { SourceAccessDenied } from '@relate/runtime';
import type { SourceConnector, SourceRecord } from '@relate/runtime';

/** The development CRM explicitly distinguishes deletion from access denial. */
export function crmConnector(baseUrl: string): SourceConnector {
  return {
    async identify({ signal }) {
      const response = await fetch(`${baseUrl}/account`, { signal });

      if (response.status === 401 || response.status === 403)
        throw new SourceAccessDenied();

      if (!response.ok) throw new Error('CRM identity unavailable');

      return ((await response.json()) as { id: string }).id;
    },
    async fetch(sourceRecordId, { signal }): Promise<SourceRecord> {
      const response = await fetch(
        `${baseUrl}/customers/${encodeURIComponent(sourceRecordId)}`,
        { signal },
      );

      if (response.status === 401 || response.status === 403)
        throw new SourceAccessDenied();

      if (!response.ok) throw new Error('CRM unavailable');

      return (await response.json()) as SourceRecord;
    },
  };
}
