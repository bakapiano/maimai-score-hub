import {
  SDGB_INTERACTIVE_QUEUE_NAME,
  SDGB_PROBE_QUEUE_NAME,
  getSdgbWorkerJobTypesForRole,
  getSdgbWorkerLaneForJobType,
  getSdgbWorkerLanesForRole,
  getSdgbWorkerQueueNameForJobType,
} from '@maimai-score-hub/shared';

describe('sdgb worker lane routing', () => {
  it.each([
    ['get_rival_hash', 'probe', SDGB_PROBE_QUEUE_NAME],
    ['get_user_map', 'probe', SDGB_PROBE_QUEUE_NAME],
    ['scan_qr', 'interactive', SDGB_INTERACTIVE_QUEUE_NAME],
    ['add_rival', 'interactive', SDGB_INTERACTIVE_QUEUE_NAME],
    ['get_music_score', 'interactive', SDGB_INTERACTIVE_QUEUE_NAME],
  ] as const)('routes %s to %s', (jobType, lane, queueName) => {
    expect(getSdgbWorkerLaneForJobType(jobType)).toBe(lane);
    expect(getSdgbWorkerQueueNameForJobType(jobType)).toBe(queueName);
  });

  it('expands worker roles into lanes and job capabilities', () => {
    expect(getSdgbWorkerLanesForRole('probe')).toEqual(['probe']);
    expect(getSdgbWorkerLanesForRole('interactive')).toEqual(['interactive']);
    expect(getSdgbWorkerLanesForRole('all')).toEqual(['probe', 'interactive']);
    expect(getSdgbWorkerJobTypesForRole('probe')).toEqual([
      'get_rival_hash',
      'get_user_map',
    ]);
    expect(getSdgbWorkerJobTypesForRole('interactive')).toEqual([
      'scan_qr',
      'add_rival',
      'get_music_score',
    ]);
  });
});
