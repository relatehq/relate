// Only JSON-safe IDs cross the Temporal boundary. No runtime objects or credentials.
export interface ApprovalInput {
  requestId: string;
  actorId: string;
}

export interface CompletionInput extends ApprovalInput {
  commandId: string;
}

export interface Activities {
  readRequest(input: ApprovalInput): Promise<{ requestId: string }>;
  completeRequest(input: CompletionInput): Promise<{ approvalId: string }>;
}

export type ApprovalResult =
  | { status: 'approved'; approvalId: string }
  | { status: 'rejected' | 'expired' };
