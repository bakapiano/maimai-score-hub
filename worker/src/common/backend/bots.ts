import { initClient } from "@ts-rest/core";
import * as sharedContract from "@maimai-score-hub/shared";
import type { ReportBotStatusBody } from "@maimai-score-hub/shared";

import { backendTsRestApi } from "./http.ts";
import { getJobServiceBaseUrl } from "./jobs.ts";

const { adminContract } = sharedContract;

const client = initClient(adminContract as any, {
  baseUrl: `${getJobServiceBaseUrl()}/api/v1`,
  api: backendTsRestApi,
}) as any;

export async function postBotStatus(
  bot: ReportBotStatusBody["bots"][number],
): Promise<void> {
  const response = await client.reportBotStatus({
    body: { bots: [bot] },
  });

  if (response.status !== 201) {
    throw new Error(`Bot status report failed: ${response.status}`);
  }
}
