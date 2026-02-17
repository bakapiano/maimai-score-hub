import { initContract } from '@ts-rest/core';

const c = initContract();

export const appContract = c.router({
  getStatus: {
    method: 'GET',
    path: '/app/status',
    responses: {
      200: c.type<{
        status: string;
        timestamp?: string;
        env?: string;
      }>(),
    },
  },
  getVersion: {
    method: 'GET',
    path: '/app/version',
    responses: {
      200: c.type<{
        version: string;
        commit?: string;
        buildTime?: string;
      }>(),
    },
  },
});
