import { GameType, getAuthUrl } from "./crawler.ts";
import { getCookieValue, loadCookie, testCookieExpired } from "./cookie.ts";

import config from "./config.ts";
import express from "express";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../static/index.html"));
});

app.get("/api/auth", async (req, res) => {
  try {
    const href = await getAuthUrl(GameType.maimai);
    res.json({ authUrl: href });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate auth URL" });
  }
});

app.get("/api/status", async (req, res) => {
  const friendCode = req.query.friendCode as string;
  if (!friendCode) {
    res.status(400).json({ error: "friendCode is required" });
    return;
  }

  try {
    const cj = await loadCookie(friendCode);
    if (!cj) {
      res.json({ expired: true });
      return;
    }

    const expired = await testCookieExpired(cj);

    if (expired) {
      res.json({ expired: true });
    } else {
      res.json({ expired: false, cookie: getCookieValue(cj) });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/api/job-service/config", (_req, res) => {
  res.json({ baseUrl: config.jobService?.baseUrl ?? "" });
});

export function startServer() {
  app.listen(config.port, () => {
    console.log(`V2 Web Service listening on port ${config.port}`);
  });
}
