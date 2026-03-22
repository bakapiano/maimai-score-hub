import { Box, Card, Group, Image, Text } from "@mantine/core";
import {
  LEVEL_COLORS,
  MINIMAL_COVER_SIZE,
  TEXT_STROKE_GOLD_BLACK,
} from "./constants";
import { getCoverUrl, getIconUrl, getRankFromScore, renderRank, parseScore } from "./utils";

import type { MusicScoreCardProps } from "./types";
import type { DisplayFilterSettings } from "../ScoreDisplayFilter";

type MinimalMusicScoreCardProps = Pick<
  MusicScoreCardProps,
  "musicId" | "chartIndex" | "type" | "score" | "fs" | "fc"
> & {
  displaySettings?: DisplayFilterSettings;
};

export function MinimalMusicScoreCard({
  musicId,
  chartIndex,
  type: _type,
  score,
  fs,
  fc,
  displaySettings,
}: MinimalMusicScoreCardProps) {
  const difficultyColor = LEVEL_COLORS[chartIndex] || "#888";
  const coverUrl = getCoverUrl(musicId);
  const rank = getRankFromScore(score);

  const showFc = displaySettings?.showFc ?? true;
  const showFs = displaySettings?.showFs ?? true;
  const showScore = displaySettings?.showScore ?? true;
  const scoreDisplayMode = displaySettings?.scoreDisplayMode ?? "rank";

  const scoreDecimals = displaySettings?.scoreDecimals ?? 2;
  const scoreNumeric = parseScore(score);
  const scoreText = (() => {
    if (scoreNumeric === null) return null;
    // Truncate without rounding
    const factor = Math.pow(10, scoreDecimals);
    const truncated = Math.floor(scoreNumeric * factor) / factor;
    return `${truncated.toFixed(scoreDecimals)}%`;
  })();

  const hasIcons = showFc || showFs;

  return (
    <Card
      withBorder
      padding="0"
      radius="sm"
      style={{
        backgroundColor: difficultyColor,
        border: `3px solid ${difficultyColor}`,
        width: "fit-content",
      }}
    >
      <Box
        style={{
          position: "relative",
          backgroundColor: difficultyColor,
        }}
      >
        <Box style={{ position: "relative" }}>
          <Image
            src={coverUrl}
            fallbackSrc="https://placehold.co/200x200?text=No+Cover"
            w={MINIMAL_COVER_SIZE}
            h={MINIMAL_COVER_SIZE}
            radius="sm"
            style={{
              display: "block",
            }}
          />

          <Box
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 0,
              textAlign: "center",
            }}
          >
            {showScore && scoreDisplayMode === "rank" && (
              <Text
                fw={900}
                size="lg"
                c="white"
                style={{ textShadow: TEXT_STROKE_GOLD_BLACK }}
              >
                {renderRank(rank)}
              </Text>
            )}
            {showScore && scoreDisplayMode === "score" && (
              <Text
                fw={900}
                size="xs"
                c="#f5d142"
                style={{ textShadow: TEXT_STROKE_GOLD_BLACK }}
              >
                {scoreText ?? "N/A"}
              </Text>
            )}
            {hasIcons && (
              <Group gap={0} align="center" justify="center">
                {showFc && (
                  <Box
                    w={24}
                    h={24}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {fc ? (
                      <Image
                        src={getIconUrl(fc)}
                        w={24}
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <Box
                        w={20}
                        h={20}
                        style={{
                          borderRadius: "50%",
                          backgroundColor: "white",
                          border: "1px solid #ccc",
                        }}
                      />
                    )}
                  </Box>
                )}
                {showFs && (
                  <Box
                    w={24}
                    h={24}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {fs ? (
                      <Image
                        src={getIconUrl(fs)}
                        w={24}
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <Box
                        w={20}
                        h={20}
                        style={{
                          borderRadius: "50%",
                          backgroundColor: "white",
                          border: "1px solid #ccc",
                        }}
                      />
                    )}
                  </Box>
                )}
              </Group>
            )}
          </Box>
        </Box>
      </Box>
    </Card>
  );
}
