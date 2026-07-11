/**
 * 舞萌好友详情页最近事件解析器。
 */

import { decodeHtmlEntities } from "@maimai-score-hub/shared";
import type {
  FriendRecentEvent,
  FriendRecentEventDifficulty,
  FriendRecentEventFc,
  FriendRecentEventFs,
} from "../../types.ts";

const activityBlockRegex =
  /<div class="p_10 t_l">\s*<div class="f_11 [^"]*">\s*([0-9/]+\s+[0-9:]+)\s*<\/div>\s*<div class="f_13 break">([\s\S]*?)<\/div>\s*<\/div>/g;

const difficultySet = new Set<FriendRecentEventDifficulty>([
  "basic",
  "advanced",
  "expert",
  "master",
  "remaster",
  "utage",
]);

export function parseFriendRecentEvents(html: string): FriendRecentEvent[] {
  const events: FriendRecentEvent[] = [];

  for (const match of html.matchAll(activityBlockRegex)) {
    const time = match[1].trim();
    const content = match[2];
    const text = normalizeText(content);
    const badges = extractFcFs(text);
    if (!badges) continue;

    const songName = extractSongName(content);
    if (!songName) continue;

    const { difficulty, difficultyImageUrl } = extractDifficulty(content);
    if (!difficulty || !difficultyImageUrl) continue;

    events.push({
      time,
      songName,
      fc: badges.fc,
      fs: badges.fs,
      difficulty,
      difficultyImageUrl,
    });
  }

  return events;
}

function extractFcFs(
  text: string,
): { fc: FriendRecentEventFc | null; fs: FriendRecentEventFs | null } | null {
  if (/ALL PERFECT\+/i.test(text)) {
    return { fc: "app", fs: null };
  }
  if (/ALL PERFECT/i.test(text)) {
    return { fc: "ap", fs: null };
  }
  if (/FULL COMBO\+/i.test(text)) {
    return { fc: "fcp", fs: null };
  }
  if (/FULL COMBO/i.test(text)) {
    return { fc: "fc", fs: null };
  }
  if (/FULL SYNC DX\+/i.test(text)) {
    return { fc: null, fs: "fdxp" };
  }
  if (/FULL SYNC DX/i.test(text)) {
    return { fc: null, fs: "fdx" };
  }
  if (/FULL SYNC\+/i.test(text)) {
    return { fc: null, fs: "fsp" };
  }
  if (/FULL SYNC/i.test(text)) {
    return { fc: null, fs: "fs" };
  }
  return null;
}

function extractSongName(content: string): string | null {
  const match = /「([\s\S]*?)」/.exec(content);
  return match ? decodeHtmlEntities(stripTags(match[1]).trim()) : null;
}

function extractDifficulty(content: string): {
  difficulty: FriendRecentEventDifficulty | null;
  difficultyImageUrl: string | null;
} {
  const match =
    /<img[^>]+src="([^"]*\/diff_([a-z]+)\.png[^"]*)"[^>]*>/i.exec(content);
  if (!match) {
    return { difficulty: null, difficultyImageUrl: null };
  }

  const rawDifficulty = match[2].toLowerCase();
  const difficulty = difficultySet.has(rawDifficulty as FriendRecentEventDifficulty)
    ? (rawDifficulty as FriendRecentEventDifficulty)
    : null;

  return {
    difficulty,
    difficultyImageUrl: decodeHtmlEntities(match[1]),
  };
}

function normalizeText(content: string): string {
  return decodeHtmlEntities(
    stripTags(content.replace(/<br\s*\/?>/gi, " "))
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function stripTags(content: string): string {
  return content.replace(/<[^>]+>/g, " ");
}
