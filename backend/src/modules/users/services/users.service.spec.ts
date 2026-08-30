import { UsersService } from './users.service';

describe('UsersService score-derived profile rating', () => {
  it('merges rating into profile behind the score-version fence', async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const service = new UsersService({ updateOne } as never);

    await expect(
      service.updateProfileRatingFromScores({
        friendCode: '634142510810999',
        rating: 15_432,
        scoreVersion: 7,
      }),
    ).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledWith(
      {
        friendCode: '634142510810999',
        $or: [
          { profileRatingScoreVersion: null },
          { profileRatingScoreVersion: { $lte: 7 } },
        ],
      },
      [
        {
          $set: {
            profile: {
              $mergeObjects: [
                {
                  avatarUrl: null,
                  title: null,
                  titleColor: null,
                  username: null,
                  rating: null,
                  ratingBgUrl: null,
                  courseRankUrl: null,
                  classRankUrl: null,
                  awakeningCount: null,
                },
                {
                  $cond: [
                    { $eq: [{ $type: '$profile' }, 'object'] },
                    '$profile',
                    {},
                  ],
                },
                { rating: 15_432 },
              ],
            },
            profileRatingScoreVersion: 7,
          },
        },
      ],
      { updatePipeline: true },
    );
  });
});
