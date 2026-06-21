import { initClient } from "@ts-rest/core";
import * as sharedContract from "@maimai-score-hub/shared";
import {
  type JobCreateBody,
  type JobCreateResponse,
  type JobRecentStats,
  type JobResponse,
  type JobWakeResponse,
} from "@maimai-score-hub/shared";

const { jobContract } = sharedContract;

const client = initClient(jobContract, {
  baseUrl: "/api/v1",
});

export async function createJob(
  body: JobCreateBody,
  authToken: string,
): Promise<JobCreateResponse> {
  const response = await client.create({
    body,
    headers: { authorization: `Bearer ${authToken}` },
  });
  if (response.status !== 201) {
    throw new Error(`Unexpected status: ${response.status}`);
  }
  return response.body;
}

export async function getJobById(jobId: string): Promise<JobResponse> {
  const response = await client.getById({ params: { jobId } });
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

export async function wakeJob(
  jobId: string,
  authToken: string,
): Promise<JobWakeResponse> {
  const response = await client.wake({
    params: { jobId },
    headers: { authorization: `Bearer ${authToken}` },
  });

  if (response.status !== 200) {
    throw new Error(`Unexpected status: ${response.status}`);
  }

  return response.body;
}

export async function getRecentJobStats(): Promise<JobRecentStats> {
  const response = await client.getRecentStats({});
  if (response.status !== 200) {
    throw new Error(`Unexpected status: ${response.status}`);
  }
  return response.body;
}
