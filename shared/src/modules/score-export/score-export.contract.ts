import { initContract } from '@ts-rest/core';

const c = initContract();

export const scoreExportContract = c.router({
  exportByFriendCode: {
    method: 'GET',
    path: '/score-export/:friendCode',
    pathParams: c.type<{ friendCode: string }>(),
    responses: {
      200: c.type<{
        friendCode: string;
        generatedAt: string;
        records: Array<Record<string, unknown>>;
      }>(),
      404: c.type<{ message: string }>(),
    },
  },
});
