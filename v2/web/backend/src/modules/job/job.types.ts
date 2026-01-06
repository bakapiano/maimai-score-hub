export type JobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled';
export type JobStage = 'send_request' | 'wait_acceptance' | 'update_score';

export interface UserProfile {
  avatarUrl: string | null;
  title: string | null;
  titleColor: string | null;
  username: string | null;
  rating: number | null;
  ratingBgUrl: string | null;
  courseRankUrl: string | null;
  classRankUrl: string | null;
  awakeningCount: number | null;
}

export interface JobResponse {
  id: string;
  friendCode: string;
  skipUpdateScore: boolean;
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
  status: JobStatus;
  stage: JobStage;
  result?: any;
  profile?: UserProfile;
  error?: string | null;
  executing?: boolean;
  createdAt: string;
  updatedAt: string;
}
