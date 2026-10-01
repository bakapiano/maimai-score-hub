import { ConflictException } from '@nestjs/common';
import type { SdgbJobPatchBody } from '@maimai-score-hub/shared';
import type { SdgbJobEntity } from '../schemas/sdgb-job.schema';
import { hashWorkerExecution, requireExecution } from './sdgb-job-patch';
import { toSdgbJobView, type SdgbJobView } from './sdgb-job.view';

export function verifiedMusicScoreCompletion(
  existing: SdgbJobEntity,
  body: SdgbJobPatchBody,
): SdgbJobView | null {
  const execution = requireExecution(body);
  if (
    existing.jobType !== 'get_music_score' ||
    existing.status !== 'completed'
  ) {
    return null;
  }
  // Read-only receipt verification remains valid after active membership ends.
  // The ordinary execution and membership fences still protect every write.
  if (existing.completionExecutionHash !== hashWorkerExecution(execution)) {
    throw new ConflictException('sdgb completion belongs to another execution');
  }
  return toSdgbJobView(existing);
}
