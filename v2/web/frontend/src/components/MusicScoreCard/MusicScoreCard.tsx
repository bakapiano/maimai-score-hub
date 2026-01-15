import { Badge, Box, Card, Group, Image, Stack, Text } from "@mantine/core";
import {
  COVER_SIZE,
  DIFFICULTY_NAMES,
  LEVEL_COLORS,
  WHITE_TEXT_STROKE,
} from "./constants";
import { getCoverUrl, getIconUrl, getRankFromScore, renderRank } from "./utils";

import type { MusicScoreCardProps } from "./types";

export function MusicScoreCard({
  musicId,
  chartIndex,
  type,
  rating,
  score,
  fs,
  fc,
  chartPayload,
  songMetadata,
  bpm: _bpm,
  noteDesigner: _noteDesigner,
}: MusicScoreCardProps) {
  const difficultyColor = LEVEL_COLORS[chartIndex] || "#888";
  const difficultyName =
    DIFFICULTY_NAMES[chartIndex]?.toUpperCase() || "UNKNOWN";

  const detailLevelText =
    typeof chartPayload?.detailLevel === "number"
      ? chartPayload.detailLevel.toFixed(1)
      : chartPayload?.detailLevel ?? "?";

  const coverUrl = getCoverUrl(musicId);
  const rank = getRankFromScore(score);

  return (
    <Card
      withBorder
      padding="sm"
      radius="md"
      style={{
        overflow: "hidden",
        backgroundColor: difficultyColor,
        border: `4px solid ${difficultyColor}`,
        display: "flex",
        flexDirection: "column",
        width: "fit-content",
      }}
    >
      {/* Top Section with Metadata and Cover */}
      <Box
        style={{
          position: "relative",
          backgroundColor: difficultyColor,
        }}
      >
        {/* Cover Art Area - Larger */}
        <Box
          p={0}
          my="auto"
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            flex: 1,
            paddingTop: 16,
            backgroundColor: difficultyColor,
          }}
        >
          <Box style={{ position: "relative" }}>
            <Image
              src={coverUrl}
              fallbackSrc="https://placehold.co/240x240?text=No+Cover"
              w={COVER_SIZE}
              h={COVER_SIZE}
              radius="sm"
              style={{
                border: `2px solid white`,
              }}
            />
            {type === "dx" ? (
              <Badge
                size="lg"
                variant="filled"
                color="orange"
                radius="sm"
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  zIndex: 10,
                  pointerEvents: "none",
                }}
              >
                DX
              </Badge>
            ) : null}

            {/* Difficulty label floats over the cover near the bottom */}
            <Box
              style={{
                position: "absolute",
                left: 8,
                right: 8,
                bottom: 8,
                display: "flex",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              <Group
                justify="space-between"
                align="center"
                style={{
                  width: "100%",
                }}
              >
                <Badge
                  size="lg"
                  variant="filled"
                  radius="sm"
                  style={{
                    backgroundColor: difficultyColor,
                    color: "white",
                  }}
                >
                  {difficultyName}
                </Badge>
                <Badge
                  size="lg"
                  variant="filled"
                  radius="sm"
                  style={{
                    backgroundColor: difficultyColor,
                    color: "white",
                  }}
                >
                  {detailLevelText}
                </Badge>
              </Group>
            </Box>
          </Box>
        </Box>

        {/* Song Attributes - More Compact */}
        <Stack align="center" gap={0} mt={4} pb={4}>
          <Box style={{ width: COVER_SIZE, overflowX: "auto" }}>
            <Text
              fw={900}
              size="md"
              lineClamp={1}
              title={songMetadata?.title}
              style={{
                zIndex: 10,
                textAlign: "center",
                lineHeight: 1.2,
                textShadow: WHITE_TEXT_STROKE,
                whiteSpace: "nowrap",
              }}
              c="white"
            >
              {songMetadata?.title || "Unknown Title"}
            </Text>
          </Box>
          <Box style={{ width: COVER_SIZE, overflowX: "auto" }}>
            <Text
              size="xs"
              c="white"
              lineClamp={1}
              style={{
                textAlign: "center",
                textShadow: WHITE_TEXT_STROKE,
                whiteSpace: "nowrap",
              }}
            >
              {songMetadata?.artist || "Unknown Artist"}
            </Text>
          </Box>
        </Stack>
      </Box>

      {/* Bottom Section - Results */}
      <Box
        p={0}
        style={{
          borderTop: "1px dashed white",
          paddingTop: 0,
          backgroundColor: difficultyColor,
          position: "relative",
        }}
      >
        <Group
          align="center"
          justify="space-between"
          wrap="nowrap"
          mt={0}
          gap={2}
          maw={200}
        >
          {/* Left Side: Score & DX Score */}
          <Stack gap={0} style={{ flex: 1 }}>
            <Group gap={2} align="baseline">
              <Text fw={900} c="#f5d142">
                {score || "N/A"}
              </Text>
              <Text fw={900} c="white">
                {renderRank(rank)}
              </Text>
            </Group>
            <Group gap={2} align="center">
              <Text fw={700} size="sm" c="white">
                RATING: {typeof rating === "number" ? Math.round(rating) : "-"}
              </Text>
            </Group>
          </Stack>

          {/* Right Side: FC & FS Circles */}
          <Stack
            gap={0}
            align="center"
            h="100%"
            style={{ justifyContent: "center", height: "100%" }}
          >
            <Group
              gap={0}
              h="100%"
              align="center"
              justify="center"
              style={{ height: "100%" }}
            >
              <Box
                w={32}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                p={0}
              >
                {fc ? (
                  <Image src={getIconUrl(fc)} w={32} />
                ) : (
                  <Box
                    w={24}
                    h={24}
                    style={{
                      borderRadius: "50%",
                      backgroundColor: "white",
                      border: "1px solid #ccc",
                    }}
                  />
                )}
              </Box>
              <Box
                w={32}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                p={0}
              >
                {fs ? (
                  <Image src={getIconUrl(fs)} w={32} />
                ) : (
                  <Box
                    w={24}
                    h={24}
                    style={{
                      borderRadius: "50%",
                      backgroundColor: "white",
                      border: "1px solid #ccc",
                    }}
                  />
                )}
              </Box>
            </Group>
          </Stack>
        </Group>
      </Box>
    </Card>
  );
}
