import type { Job, JobStage, JobStatus } from "./state.ts";
import { state, toJobResponse } from "./state.ts";

import config from "./config.ts";
import express from "express";
import { randomUUID } from "crypto";

const app = express();

const JSON_BODY_LIMIT = 100 * 1024 * 1024; // 100 MB cap for job payloads
app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/job/create", (req, res) => {
  const { friendCode, skipUpdateScore } = req.body ?? {};
  if (!friendCode || typeof friendCode !== "string") {
    res.status(400).json({ error: "friendCode is required" });
    return;
  }

  if (skipUpdateScore !== undefined && typeof skipUpdateScore !== "boolean") {
    res.status(400).json({ error: "skipUpdateScore must be a boolean" });
    return;
  }

  const id = randomUUID();
  const now = new Date();
  const job: Job = {
    id,
    friendCode,
    skipUpdateScore: skipUpdateScore ?? false,
    botUserFriendCode: null,
    status: "queued",
    stage: "send_request",
    retryCount: 0,
    executing: false,
    createdAt: now,
    updatedAt: now,
  };

  state.jobs.set(id, job);

  res.status(201).json({ jobId: id, job: toJobResponse(job) });
});

app.get("/api/job/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = state.jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(toJobResponse(job));
});

app.post("/api/job/next", (_req, res) => {
  const now = Date.now();
  let selected: Job | undefined;

  for (const job of state.jobs.values()) {
    const eligibleStatus =
      job.status === "queued" || job.status === "processing";
    const notExecuting = !job.executing;
    const retryReady = !job.nextRetryAt || job.nextRetryAt.getTime() <= now;

    if (eligibleStatus && notExecuting && retryReady) {
      if (!selected || job.createdAt.getTime() < selected.createdAt.getTime()) {
        selected = job;
      }
    }
  }

  if (!selected) {
    res.status(204).send();
    return;
  }

  if (selected.status === "queued") {
    selected.status = "processing";
    selected.stage = "send_request";
  }
  selected.executing = true;
  selected.updatedAt = new Date();

  state.jobs.set(selected.id, selected);

  res.json(toJobResponse(selected));
});

app.patch("/api/job/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = state.jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const {
    botUserFriendCode,
    status,
    stage,
    result,
    error,
    executing,
    retryCount,
    nextRetryAt,
    updatedAt,
  } = req.body ?? {};

  if (botUserFriendCode !== undefined) {
    job.botUserFriendCode = botUserFriendCode;
  }

  if (status !== undefined) {
    if (!isValidStatus(status)) {
      res.status(400).json({ error: "Invalid status value" });
      return;
    }
    job.status = status;
  }

  if (stage !== undefined) {
    if (!isValidStage(stage)) {
      res.status(400).json({ error: "Invalid stage value" });
      return;
    }
    job.stage = stage;
  }

  if (result !== undefined) {
    job.result = result;
  }

  if (error !== undefined) {
    job.error = error;
  }

  if (executing !== undefined) {
    job.executing = executing;
  }

  if (retryCount !== undefined) {
    if (typeof retryCount !== "number" || Number.isNaN(retryCount)) {
      res.status(400).json({ error: "retryCount must be a number" });
      return;
    }
    job.retryCount = retryCount;
  }

  if (nextRetryAt !== undefined) {
    if (nextRetryAt === null) {
      job.nextRetryAt = null;
    } else if (typeof nextRetryAt === "string") {
      const parsed = new Date(nextRetryAt);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: "nextRetryAt must be a valid ISO date" });
        return;
      }
      job.nextRetryAt = parsed;
    } else {
      res.status(400).json({ error: "nextRetryAt must be null or ISO string" });
      return;
    }
  }

  if (updatedAt !== undefined) {
    if (typeof updatedAt !== "string") {
      res.status(400).json({ error: "updatedAt must be an ISO string" });
      return;
    }
    const parsed = new Date(updatedAt);
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: "updatedAt must be a valid ISO date" });
      return;
    }
    job.updatedAt = parsed;
  } else {
    job.updatedAt = new Date();
  }

  state.jobs.set(jobId, job);

  res.json(toJobResponse(job));
});

export function startServer() {
  app.listen(config.port, () => {
    console.log(`Job service listening on port ${config.port}`);
  });
}

function isValidStatus(value: any): value is JobStatus {
  return (
    value === "queued" ||
    value === "processing" ||
    value === "completed" ||
    value === "failed"
  );
}

function isValidStage(value: any): value is JobStage {
  return (
    value === "send_request" ||
    value === "wait_acceptance" ||
    value === "update_score"
  );
}
