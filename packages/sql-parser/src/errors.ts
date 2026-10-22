import type { SourceSpan, SqlIssue } from 'relate/analytics';

export class RejectedSql extends Error {
  constructor(readonly issue: SqlIssue) {
    super(issue.message);
  }
}

export function reject(
  problem: SqlIssue['problem'],
  message: string,
  at?: SourceSpan,
): never {
  throw new RejectedSql({
    problem,
    message,
    ...(at ? { at: { start: at.start, end: at.end } } : {}),
  });
}

export function unsupported(at?: SourceSpan): never {
  return reject(
    'not-supported',
    'This SQL construct is outside the analytical subset.',
    at,
  );
}
