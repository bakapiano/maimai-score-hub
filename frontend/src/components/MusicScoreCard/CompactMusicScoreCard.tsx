import { Badge, Box, Card, Text } from "@mantine/core";
import {
  COMPACT_COVER_SIZE,
  DIFFICULTY_NAMES,
  GLASS_TEXT_SHADOW,
  GOLD_SCORE_STROKE_STYLE,
  LEVEL_COLORS,
} from "./constants";
import {
  getCoverUrl,
  getRankFromScore,
  renderRank,
  renderScoreStatusIcon,
} from "./utils";

import { DeferredImage } from "../DeferredImage";
import type { MusicScoreCardProps } from "./types";

export function CompactMusicScoreCard({
  musicId,
  chartIndex,
  type,
  rating,
  score,
  fs,
  fc,
  chartPayload,
  songMetadata,
}: MusicScoreCardProps) {
  const difficultyColor = LEVEL_COLORS[chartIndex] || "#888";
  const difficultyName = DIFFICULTY_NAMES[chartIndex] || "UNKNOWN";

  const detailLevelText =
    typeof chartPayload?.detailLevel === "number"
      ? chartPayload.detailLevel.toFixed(1)
      : chartPayload?.detailLevel ?? "?";

  const ratingText = typeof rating === "number" ? Math.round(rating) : "-";
  const coverUrl = getCoverUrl(musicId);
  const rank = getRankFromScore(score);

  return (
    <Card
      withBorder
      padding="0"
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
          padding: 6,
        }}
      >
        <Box style={{ position: "relative" }}>
          <DeferredImage
            src={coverUrl}
            w={COMPACT_COVER_SIZE}
            h={COMPACT_COVER_SIZE}
            radius="sm"
            style={{
              border: "2px solid white",
              display: "block",
            }}
          />

          <Box
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 6,
              background:
                "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))",
              backdropFilter: "blur(0.5px)",
              WebkitBackdropFilter: "blur(0.5px)",
              border: "1px solid rgba(255,255,255,0.12)",
              boxShadow: "inset 0 1px 3px rgba(255,255,255,0.20)",
              pointerEvents: "none",
            }}
          />

          {type === "dx" ? (
            <Badge
              size="sm"
              variant="filled"
              color="orange"
              radius="sm"
              style={{
                position: "absolute",
                top: 6,
                right: 6,
                zIndex: 10,
                pointerEvents: "none",
              }}
            >
              DX
            </Badge>
          ) : null}

          <Badge
            size="sm"
            variant="filled"
            radius="sm"
            tt="none"
            style={{
              position: "absolute",
              top: 6,
              left: 6,
              zIndex: 10,
              backgroundColor: difficultyColor,
              color: "white",
            }}
          >
            {`${detailLevelText} ${difficultyName}`}
          </Badge>

          <Badge
            size="sm"
            variant="filled"
            radius="sm"
            tt="none"
            style={{
              position: "absolute",
              bottom: 6,
              left: 6,
              zIndex: 10,
              backgroundColor: "rgba(0,0,0,0.6)",
              color: "white",
            }}
          >
            {`Rating: ${ratingText}`}
          </Badge>

          <Box
            style={{
              position: "absolute",
              bottom: 3,
              right: 3,
              zIndex: 10,
              display: "flex",
              alignItems: "center",
              gap: 0,
              pointerEvents: "none",
            }}
          >
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
                renderScoreStatusIcon(fc, { size: 24, stroke: true })
              ) : (
                <Box
                  w={20}
                  h={20}
                  style={{
                    borderRadius: "50%",
                    backgroundColor: "rgba(255, 255, 255, 0.62)",
                    border: "1px solid rgba(204, 204, 204, 0.62)",
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
                renderScoreStatusIcon(fs, { size: 24, stroke: true })
              ) : (
                <Box
                  w={20}
                  h={20}
                  style={{
                    borderRadius: "50%",
                    backgroundColor: "rgba(255, 255, 255, 0.62)",
                    border: "1px solid rgba(204, 204, 204, 0.62)",
                  }}
                />
              )}
            </Box>
          </Box>

          <Box
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 4,
              textAlign: "center",
            }}
          >
            <Text
              fw={900}
              size="lg"
              style={GOLD_SCORE_STROKE_STYLE}
              mb={-12}
            >
              {score || "N/A"}
            </Text>
            <Text
              fw={900}
              size="lg"
              style={GOLD_SCORE_STROKE_STYLE}
              mb={-12}
            >
              {renderRank(rank, { stroke: true })}
            </Text>
          </Box>
        </Box>

        <Box style={{ pointerEvents: "none" }}>
          <Text
            fw={900}
            size="12"
            lineClamp={1}
            title={songMetadata?.title}
            style={{
              textAlign: "center",
              lineHeight: 1.2,
              textShadow: GLASS_TEXT_SHADOW,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: COMPACT_COVER_SIZE,
            }}
            c="white"
            mt={4}
            mb={-4}
          >
            {songMetadata?.title || "Unknown Title"}
          </Text>
        </Box>
      </Box>
    </Card>
  );
}
