import type { Model } from 'mongoose';
import type { JobResponse } from './job.types';
import { JobEntity } from './job.schema';
export declare class JobService {
    private readonly jobModel;
    constructor(jobModel: Model<JobEntity>);
    create(input: {
        friendCode: string;
        skipUpdateScore: boolean;
    }): Promise<{
        jobId: `${string}-${string}-${string}-${string}-${string}`;
        job: JobResponse;
    }>;
    get(jobId: string): Promise<JobResponse>;
    claimNext(): Promise<JobResponse | null>;
    patch(jobId: string, body: any): Promise<JobResponse>;
}
