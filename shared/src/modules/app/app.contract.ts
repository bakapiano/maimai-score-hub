import { initContract } from "@ts-rest/core";

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
});
