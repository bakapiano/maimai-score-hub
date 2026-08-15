import type { SyncScore } from '../../sync/schemas/sync.schema';
import {
  renderBest50Image,
  renderLevelScoresImage,
  renderScoreHistoryImage,
  renderVersionScoresImage,
} from '../rendering/score-export.render';
import { ScoreExportService } from './score-export.service';

jest.mock('../rendering/score-export.fonts', () => ({
  ensureFontsLoaded: jest.fn(),
}));

jest.mock('../rendering/score-export.render', () => ({
  renderBest50Image: jest.fn().mockResolvedValue(Buffer.from('best50')),
  renderLevelScoresImage: jest.fn().mockResolvedValue(Buffer.from('level')),
  renderScoreHistoryImage: jest.fn().mockResolvedValue(Buffer.from('history')),
  renderVersionScoresImage: jest.fn().mockResolvedValue(Buffer.from('version')),
}));

const FRIEND_CODE = '123456789012345';
const STALE_PROFILE_RATING = 12_345;
const CURRENT_RATING = 300;

const profile = {
  avatarUrl: null,
  title: null,
  titleColor: null,
  username: 'Tester',
  rating: STALE_PROFILE_RATING,
  ratingBgUrl: null,
  courseRankUrl: null,
  classRankUrl: null,
  awakeningCount: null,
};

const scores: SyncScore[] = [
  {
    musicId: '1',
    cid: 'new-chart',
    chartIndex: 0,
    type: 'dx',
    dxScore: '300',
    score: '100.0000%',
    fs: null,
    fc: null,
    rating: 200,
    isNew: true,
  },
  {
    musicId: '2',
    cid: 'old-chart',
    chartIndex: 0,
    type: 'standard',
    dxScore: '300',
    score: '100.0000%',
    fs: null,
    fc: null,
    rating: 100,
    isNew: false,
  },
];

const musics = [
  {
    id: '1',
    title: 'New Song',
    type: 'dx',
    version: 'prism',
    isNew: true,
    charts: [
      {
        cid: 'new-chart',
        level: '13',
        detailLevel: 13,
        notes: [100],
      },
    ],
  },
  {
    id: '2',
    title: 'Old Song',
    type: 'standard',
    version: 'festival',
    isNew: false,
    charts: [
      {
        cid: 'old-chart',
        level: '12',
        detailLevel: 12,
        notes: [100],
      },
    ],
  },
];

describe('ScoreExportService rating headers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the latest score snapshot B50 for every exported image', async () => {
    const syncQuery = {
      sort: jest.fn(),
      lean: jest.fn().mockResolvedValue({ scores }),
    };
    syncQuery.sort.mockReturnValue(syncQuery);

    const historyQuery = {
      sort: jest.fn(),
      lean: jest.fn().mockResolvedValue([
        {
          id: 'change-1',
          friendCode: FRIEND_CODE,
          musicId: '1',
          chartIndex: 0,
          type: 'dx',
          observedAt: new Date('2026-08-15T04:00:00.000Z'),
          changedFields: ['rating'],
          before: { score: '99.0000%', dxScore: '290', rating: 190 },
          after: { score: '100.0000%', dxScore: '300', rating: 200 },
        },
      ]),
    };
    historyQuery.sort.mockReturnValue(historyQuery);

    const service = new ScoreExportService(
      { findOne: jest.fn().mockReturnValue(syncQuery) } as never,
      {
        find: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(musics),
        }),
      } as never,
      { find: jest.fn().mockReturnValue(historyQuery) } as never,
      {} as never,
      {
        findByFriendCode: jest.fn().mockResolvedValue({ profile }),
      } as never,
    );

    await service.generateBest50Image(FRIEND_CODE);
    await service.generateLevelScoresImage(FRIEND_CODE, '13');
    await service.generateVersionScoresImage(FRIEND_CODE, 'prism');
    await service.generateScoreHistoryImage(FRIEND_CODE, {
      date: '2026-08-15',
      start: Date.parse('2026-08-14T22:00:00.000Z'),
      end: Date.parse('2026-08-15T22:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
      dayStartHour: 6,
      keyChangesOnly: false,
    });

    const best50Payload = jest.mocked(renderBest50Image).mock.calls[0][0];
    expect(best50Payload.rating).toBe(CURRENT_RATING);
    expect(best50Payload.profile?.rating).toBe(STALE_PROFILE_RATING);
    expect(jest.mocked(renderLevelScoresImage).mock.calls[0][3]).toBe(
      CURRENT_RATING,
    );
    expect(jest.mocked(renderVersionScoresImage).mock.calls[0][3]).toBe(
      CURRENT_RATING,
    );
    expect(jest.mocked(renderScoreHistoryImage).mock.calls[0][0].rating).toBe(
      CURRENT_RATING,
    );
  });
});
