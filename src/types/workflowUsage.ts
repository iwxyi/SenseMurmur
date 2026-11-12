export interface WorkflowUsageReference {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  attempt: number;
  kind: 'model' | 'tool';
}

export interface WorkflowUsageSummary {
  coverage: 'available_server_records';
  asOf: number;
  units: Array<{
    billingUnit: string | null;
    settledAmount: string;
    reservedAmount: string;
    settledRequests: number;
    pendingRequests: number;
    unpricedRequests: number;
  }>;
}

export interface WorkflowBudget {
  schemaVersion: 1;
  runId: string;
  billingUnit: string;
  limitAmount: string;
  revision: number;
  committedAmount: string;
  reservedAmount: string;
  remainingAmount: string;
  exceeded: boolean;
  unresolvedRequests: number;
  updatedAt: number;
}
