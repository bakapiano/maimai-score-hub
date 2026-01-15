import { Badge, Box, Card, Image, Text } from "@mantine/core";
import {
  COMPACT_COVER_SIZE,
  DIFFICULTY_NAMES,
  GLASS_TEXT_SHADOW,
  LEVEL_COLORS,
  TEXT_STROKE_GOLD_BLACK,
} from "./constants";
import { getCoverUrl, getIconUrl, getRankFromScore, renderRank } from "./utils";

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
  const difficultyName =
    DIFFICULTY_NAMES[chartIndex]?.toUpperCase() || "UNKNOWN";

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
      radius="md"
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
          padding: 8,
        }}
      >
        <Box style={{ position: "relative" }}>
          <Image
            src={coverUrl}
            fallbackSrc="https://placehold.co/220x220?text=No+Cover"
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
              backdropFilter: "blur(2px)",
              WebkitBackdropFilter: "blur(2px)",
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
                top: 8,
                right: 8,
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
            style={{
              position: "absolute",
              top: 8,
              left: 8,
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
            style={{
              position: "absolute",
              bottom: 8,
              left: 8,
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
              bottom: 5,
              right: 5,
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
                <Image src={getIconUrl(fs)} w={24} h={24} />
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
              c="#f5d142"
              style={{ textShadow: TEXT_STROKE_GOLD_BLACK }}
              mb={-12}
            >
              {score || "N/A"}
            </Text>
            <Text
              fw={900}
              size="lg"
              c="#f5d142"
              style={{ textShadow: TEXT_STROKE_GOLD_BLACK }}
              mb={-12}
            >
              {renderRank(rank)}
            </Text>
          </Box>
        </Box>

        <Box
          style={{
            pointerEvents: "none",
          }}
        >
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
