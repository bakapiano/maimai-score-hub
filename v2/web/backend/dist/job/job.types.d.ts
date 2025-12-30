export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type JobStage = 'send_request' | 'wait_acceptance' | 'update_score';
export interface JobResponse {
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
    nextRetryAt?: string | null;
    createdAt: string;
    updatedAt: string;
}
