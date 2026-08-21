import type { JobStatus } from "@maimai-score-hub/shared";

export type JobStatusDisposition = "active" | "succeeded" | "failed";

export function parseJobStatus(value: unknown): JobStatus | null {
  switch (value) {
    case "queued":
    case "processing":
    case "completed":
    case "failed":
    case "canceled":
      return value;
    default:
      return null;
  }
}

export function getJobStatusDisposition(
  status: JobStatus,
): JobStatusDisposition {
  switch (status) {
    case "queued":
    case "processing":
      return "active";
    case "completed":
      return "succeeded";
    case "failed":
    case "canceled":
      return "failed";
  }
}
