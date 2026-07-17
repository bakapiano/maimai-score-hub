import type { SdgbLanePolicy, SdgbWorkerClass } from '@maimai-score-hub/shared';

import {
  selectSdgbLaneMembers,
  type SdgbLaneCandidate,
} from './sdgb-lane-selection';

const probePolicy: SdgbLanePolicy = {
  lane: 'probe',
  preferredClass: 'recoverable',
  preferredActiveCount: 2,
  fallbackClass: 'stable',
  fallbackActiveCount: 2,
};

function candidate(
  workerId: string,
  workerClass: SdgbWorkerClass,
  activeJobCount = 0,
): SdgbLaneCandidate {
  return {
    workerId,
    workerClass,
    capabilities: ['probe', 'interactive'],
    activeJobCount,
    healthySinceMs: 1,
  };
}

describe('selectSdgbLaneMembers', () => {
  it('selects multiple preferred workers up to the configured count', () => {
    const selected = selectSdgbLaneMembers(
      probePolicy,
      [
        candidate('recoverable-c', 'recoverable', 3),
        candidate('recoverable-a', 'recoverable', 1),
        candidate('recoverable-b', 'recoverable', 2),
        candidate('stable-a', 'stable'),
      ],
      new Set(),
    );

    expect(selected.map((worker) => worker.workerId)).toEqual([
      'recoverable-a',
      'recoverable-b',
    ]);
  });

  it('does not fill a preferred shortfall with fallback workers', () => {
    const selected = selectSdgbLaneMembers(
      probePolicy,
      [
        candidate('recoverable-a', 'recoverable'),
        candidate('stable-a', 'stable'),
        candidate('stable-b', 'stable'),
      ],
      new Set(),
    );

    expect(selected.map((worker) => worker.workerId)).toEqual([
      'recoverable-a',
    ]);
  });

  it('activates fallback workers only when preferred candidates are zero', () => {
    const selected = selectSdgbLaneMembers(
      probePolicy,
      [
        candidate('stable-a', 'stable'),
        candidate('stable-b', 'stable'),
        candidate('stable-c', 'stable'),
      ],
      new Set(),
    );

    expect(selected.map((worker) => worker.workerId)).toEqual([
      'stable-a',
      'stable-b',
    ]);
  });

  it('keeps healthy current members before moving traffic', () => {
    const selected = selectSdgbLaneMembers(
      { ...probePolicy, preferredActiveCount: 1 },
      [
        candidate('recoverable-new', 'recoverable', 0),
        candidate('recoverable-current', 'recoverable', 10),
      ],
      new Set(['recoverable-current']),
    );

    expect(selected.map((worker) => worker.workerId)).toEqual([
      'recoverable-current',
    ]);
  });

  it('excludes workers without the lane capability', () => {
    const selected = selectSdgbLaneMembers(
      probePolicy,
      [
        {
          ...candidate('recoverable-interactive', 'recoverable'),
          capabilities: ['interactive'],
        },
        candidate('stable-a', 'stable'),
      ],
      new Set(),
    );

    expect(selected.map((worker) => worker.workerId)).toEqual(['stable-a']);
  });
});
