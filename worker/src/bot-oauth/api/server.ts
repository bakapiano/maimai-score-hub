import express from "express";
import { fileURLToPath } from "url";
import path from "path";

import config from "../../common/config.ts";
import { botManager } from "../../common/bots/bot-manager.ts";
import { getAuthUrl } from "../../common/maimai/infra/auth.ts";
import { GameType } from "../../common/types.ts";
import { runtimeState } from "../common/runtime-state.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_INDEX_PATH = path.join(__dirname, "../../../static/index.html");

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (_req, res) => {
  res.sendFile(STATIC_INDEX_PATH);
});

app.get("/api/auth", async (req, res) => {
  try {
    const redirectUrl = req.query.redirectUrl as string | undefined;
    if (redirectUrl) {
      runtimeState.redirectUrl = redirectUrl;
    }

    const href = await getAuthUrl(GameType.maimai);
    console.log(href);
    res.json({ authUrl: href });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate auth URL" });
  }
});

app.get("/api/status", async (_req, res) => {
  try {
    if (runtimeState.isAuthOngoing) {
      res.json({ status: "ok", authOngoing: true, expired: false });
      return;
    }

    const bot = botManager.getBot();
    if (!bot) {
      res.json({ expired: true });
      return;
    }

    if (bot.expired) {
      res.json({ expired: true, friendCode: bot.friendCode });
      return;
    }

    // Do not expose bot session cookies from the public-facing OAuth helper.
    res.json({ expired: false, friendCode: bot.friendCode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export function startApiServer(): ReturnType<typeof app.listen> {
  return app.listen(config.port, () => {
    console.log(`[BotOAuth] API server listening on port ${config.port}`);
  });
}
