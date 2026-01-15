import { Box, Card, Group, Image, Text } from "@mantine/core";
import {
  LEVEL_COLORS,
  MINIMAL_COVER_SIZE,
  TEXT_STROKE_GOLD_BLACK,
} from "./constants";
import { getCoverUrl, getIconUrl, getRankFromScore, renderRank } from "./utils";

import type { MusicScoreCardProps } from "./types";

export function MinimalMusicScoreCard({
  musicId,
  chartIndex,
  type: _type,
  score,
  fs,
  fc,
}: Pick<
  MusicScoreCardProps,
  "musicId" | "chartIndex" | "type" | "score" | "fs" | "fc"
>) {
  const difficultyColor = LEVEL_COLORS[chartIndex] || "#888";
  const coverUrl = getCoverUrl(musicId);
  const rank = getRankFromScore(score);

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
            <Text
              fw={900}
              size="lg"
              c="white"
              style={{ textShadow: TEXT_STROKE_GOLD_BLACK }}
            >
              {renderRank(rank)}
            </Text>
            <Group gap={0} align="center" justify="center">
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
                  <Image src={getIconUrl(fc)} w={24} />
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
                  <Image src={getIconUrl(fs)} w={24} />
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
            </Group>
          </Box>
        </Box>
      </Box>
    </Card>
  );
}
