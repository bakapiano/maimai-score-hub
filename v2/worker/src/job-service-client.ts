import config from "./config.ts";

export type JobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "canceled";
export type JobStage = "send_request" | "wait_acceptance" | "update_score";

export interface Job {
  id: string;
  friendCode: string;
  skipUpdateScore?: boolean;
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
  status: JobStatus;
  stage: JobStage;
  result?: any;
  error?: string | null;
  executing?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type JobResponse = Omit<Job, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

export interface JobPatch {
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
  status?: JobStatus;
  stage?: JobStage;
  result?: any;
  error?: string | null;
  executing?: boolean;
  updatedAt?: Date;
}

const baseUrl = (config.jobService?.baseUrl ?? "").replace(/\/$/, "");

function ensureBaseUrl() {
  if (!baseUrl) {
    throw new Error("Job service baseUrl is not configured");
  }
  return baseUrl;
}

function buildUrl(path: string) {
  return `${ensureBaseUrl()}${path}`;
}

function deserializeJob(payload: JobResponse): Job {
  return {
    ...payload,
    createdAt: new Date(payload.createdAt),
    updatedAt: new Date(payload.updatedAt),
  };
}

function serializePatch(patch: JobPatch) {
  const body: Record<string, unknown> = {};

  if (patch.botUserFriendCode !== undefined) {
    body.botUserFriendCode = patch.botUserFriendCode;
  }
  if (patch.friendRequestSentAt !== undefined) {
    body.friendRequestSentAt = patch.friendRequestSentAt;
  }
  if (patch.status !== undefined) {
    body.status = patch.status;
  }
  if (patch.stage !== undefined) {
    body.stage = patch.stage;
  }
  if (patch.result !== undefined) {
    body.result = patch.result;
  }
  if (patch.error !== undefined) {
    body.error = patch.error;
  }
  if (patch.executing !== undefined) {
    body.executing = patch.executing;
  }
  body.updatedAt = (patch.updatedAt ?? new Date()).toISOString();

  return body;
}

export async function claimNextJob(
  botUserFriendCode?: string
): Promise<Job | null> {
  const response = await fetch(buildUrl("/api/job/next"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botUserFriendCode }),
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to claim next job. Status: ${response.status}. Body: ${text}`
    );
  }

  const payload = (await response.json()) as JobResponse;
  return deserializeJob(payload);
}

export async function updateJob(
  jobId: string,
  patch: JobPatch,
  signal?: AbortSignal
): Promise<Job> {
  const response = await fetch(buildUrl(`/api/job/${jobId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(serializePatch(patch)),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to update job ${jobId}. Status: ${response.status}. Body: ${text}`
    );
  }

  const payload = (await response.json()) as JobResponse;
  return deserializeJob(payload);
}

export async function getJob(jobId: string): Promise<Job> {
  const response = await fetch(buildUrl(`/api/job/${jobId}`));
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch job ${jobId}. Status: ${response.status}. Body: ${text}`
    );
  }

  const payload = (await response.json()) as JobResponse;
  return deserializeJob(payload);
}
