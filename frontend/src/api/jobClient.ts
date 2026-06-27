import { initClient } from "@ts-rest/core";
import * as sharedContract from "@maimai-score-hub/shared";
import {
  type JobCreateBody,
  type JobCreateResponse,
  type JobFriendshipStatusResponse,
  type JobResponse,
  type JobVerifyResponse,
} from "@maimai-score-hub/shared";

const { jobContract } = sharedContract;

const client = initClient(jobContract, {
  baseUrl: "/api/v1",
});

export class JobApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly recommendedBotFriendCode?: string | null;

  constructor(
    message: string,
    status: number,
    code?: string,
    recommendedBotFriendCode?: string | null,
  ) {
    super(message);
    this.name = "JobApiError";
    this.status = status;
    this.code = code;
    this.recommendedBotFriendCode = recommendedBotFriendCode;
  }
}

export async function createJob(
  body: JobCreateBody,
  authToken: string,
): Promise<JobCreateResponse> {
  const response = await client.create({
    body,
    headers: { authorization: `Bearer ${authToken}` },
  });
  if (response.status !== 201) {
    const errorBody = response.body as
      | {
          code?: string;
          message?: string | string[];
          recommendedBotFriendCode?: string | null;
        }
      | undefined;
    const message = Array.isArray(errorBody?.message)
      ? errorBody.message.join(", ")
      : (errorBody?.message ?? `Unexpected status: ${response.status}`);
    throw new JobApiError(
      message,
      response.status,
      errorBody?.code,
      errorBody?.recommendedBotFriendCode,
    );
  }
  return response.body;
}

export async function getFriendshipStatus(
  authToken: string,
): Promise<JobFriendshipStatusResponse> {
  const response = await client.getFriendshipStatus({
    headers: { authorization: `Bearer ${authToken}` },
  });
  if (response.status !== 200) {
    throw new Error(`Unexpected status: ${response.status}`);
  }
  return response.body;
}

export async function getJobById(
  jobId: string,
  authToken: string,
): Promise<JobResponse> {
  const response = await client.getById({
    params: { jobId },
    headers: { authorization: `Bearer ${authToken}` },
  });
  if (response.status !== 200) {
    throw new Error(`Unexpected status: ${response.status}`);
  }
  return response.body;
}

export async function getActiveJobByFriendCode(
  _friendCode: string,
  authToken: string,
): Promise<{ job: JobResponse | null }> {
  const response = await client.getActiveByFriendCode({
    headers: { authorization: `Bearer ${authToken}` },
  });

  if (response.status !== 200) {
    throw new Error(`Unexpected status: ${response.status}`);
  }

  return response.body;
}

export async function verifyJob(
  jobId: string,
  authToken: string,
): Promise<JobVerifyResponse> {
  const response = await client.verify({
    params: { jobId },
    headers: { authorization: `Bearer ${authToken}` },
  });

  if (response.status !== 200) {
    throw new Error(`Unexpected status: ${response.status}`);
  }

  return response.body;
}
