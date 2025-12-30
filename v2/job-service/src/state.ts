export type JobStatus = "queued" | "processing" | "completed" | "failed";
export type JobStage = "send_request" | "wait_acceptance" | "update_score";

export interface Job {
  id: string;
  friendCode: string;
  skipUpdateScore: boolean;
  botUserFriendCode?: string | null;
  status: JobStatus;
  stage: JobStage;
  result?: any;
  error?: string | null;
  executing?: boolean;
  retryCount: number;
  nextRetryAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobResponse
  extends Omit<Job, "createdAt" | "updatedAt" | "nextRetryAt"> {
  createdAt: string;
  updatedAt: string;
  nextRetryAt?: string | null;
}

export const state = {
  jobs: new Map<string, Job>(),
};

export function toJobResponse(job: Job): JobResponse {
  return {
    ...job,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    nextRetryAt: job.nextRetryAt ? job.nextRetryAt.toISOString() : null,
  };
}
