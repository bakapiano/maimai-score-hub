import type { Response } from 'express';
import { JobService } from './job.service';
export declare class JobController {
    private readonly jobs;
    constructor(jobs: JobService);
    create(body: {
        friendCode?: unknown;
        skipUpdateScore?: unknown;
    }): Promise<{
        jobId: `${string}-${string}-${string}-${string}-${string}`;
        job: import("./job.types").JobResponse;
    }>;
    get(jobId: string): Promise<import("./job.types").JobResponse>;
    next(res: Response): Promise<void>;
    patch(jobId: string, body: any): Promise<import("./job.types").JobResponse>;
}
