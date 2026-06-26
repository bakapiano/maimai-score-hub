import { initContract } from "@ts-rest/core";

import { AppStatisticsSchema } from "./app.schema";

const c = initContract();

export const appContract = c.router({
  getStatus: {
    method: "GET",
    path: "/health",
    responses: {
      200: c.type<{
        status: string;
        timestamp?: string;
        env?: string;
      }>(),
    },
  },
  getStatistics: {
    method: "GET",
    path: "/statistics",
    responses: {
      200: AppStatisticsSchema,
    },
  },
});
