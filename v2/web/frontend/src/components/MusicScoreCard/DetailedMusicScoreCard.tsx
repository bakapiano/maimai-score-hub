import {
  ActionIcon,
  Badge,
  Box,
  Card,
  Divider,
  Group,
  Image,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import {
  DETAILED_COVER_SIZE,
  DIFFICULTY_NAMES,
  LEVEL_COLORS,
} from "./constants";
import {
  IconBrandBilibili,
  IconBrandYoutube,
  IconCategory,
  IconClock,
  IconMusic,
  IconTrophy,
  IconUser,
  IconVersions,
} from "@tabler/icons-react";
import { getCoverUrl, getIconUrl, getRankFromScore, renderRank } from "./utils";

import type { DetailedMusicScoreCardProps } from "./types";

/**
 * Detailed Music Score Card for modal/popup display
 * Shows comprehensive score information
 */
export function DetailedMusicScoreCard({
  musicId,
  chartIndex,
  type,
  rating,
  score,
  fs,
  fc,
  chartPayload,
  songMetadata,
  bpm,
  noteDesigner,
  dxScore,
  maxDxScore,
  ranking,
  isNew,
}: DetailedMusicScoreCardProps) {
  const difficultyColor = LEVEL_COLORS[chartIndex] || "#888";
  const difficultyName =
    DIFFICULTY_NAMES[chartIndex]?.toUpperCase() || "UNKNOWN";

  const detailLevelText =
    typeof chartPayload?.detailLevel === "number"
      ? chartPayload.detailLevel.toFixed(1)
      : chartPayload?.detailLevel ?? "?";

  const coverUrl = getCoverUrl(musicId);
  const rank = getRankFromScore(score);
  const displayBpm = bpm ?? songMetadata?.bpm ?? null;

  // Generate search URLs for Bilibili and YouTube
  const searchQuery = `${songMetadata?.title || ""} ${difficultyName}`.trim();
  const bilibiliSearchUrl = `https://search.bilibili.com/all?keyword=${encodeURIComponent(
    searchQuery
  )}`;
  const youtubeSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(
    searchQuery
  )}`;

  // Detect if user is on mobile (for opening in app vs browser)
  const isMobile =
    typeof navigator !== "undefined" &&
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );

  const handleBilibiliSearch = () => {
    if (isMobile) {
      // Try to open Bilibili app on mobile, fallback to web
      window.location.href = `bilibili://search?keyword=${encodeURIComponent(
        searchQuery
      )}`;
      setTimeout(() => {
        window.open(bilibiliSearchUrl, "_blank");
      }, 500);
    } else {
      window.open(bilibiliSearchUrl, "_blank");
    }
  };

  const handleYoutubeSearch = () => {
    if (isMobile) {
      // Try to open YouTube app on mobile, fallback to web
      window.location.href = `youtube://results?search_query=${encodeURIComponent(
        searchQuery
      )}`;
      setTimeout(() => {
        window.open(youtubeSearchUrl, "_blank");
      }, 500);
    } else {
      window.open(youtubeSearchUrl, "_blank");
    }
  };

  return (
    <Card
      withBorder
      padding={0}
      radius="lg"
      style={{
        overflow: "hidden",
        backgroundColor: "#1a1a2e",
        border: `4px solid ${difficultyColor}`,
        maxWidth: 380,
        width: "100%",
      }}
    >
      {/* Header with Cover and Basic Info */}
      <Box
        style={{
          position: "relative",
          background: `linear-gradient(180deg, ${difficultyColor}cc 0%, ${difficultyColor}88 100%)`,
        }}
      >
        {/* Cover Art */}
        <Box
          p="md"
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Box style={{ position: "relative" }}>
            <Image
              src={coverUrl}
              fallbackSrc="https://placehold.co/280x280?text=No+Cover"
              w={DETAILED_COVER_SIZE}
              h={DETAILED_COVER_SIZE}
              radius="md"
              style={{
                border: `3px solid white`,
                boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
              }}
            />

            {/* Type Badge (DX/SD) */}
            <Badge
              size="lg"
              variant="filled"
              color={type === "dx" ? "orange" : "blue"}
              radius="sm"
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                zIndex: 10,
                fontSize: 14,
                fontWeight: 900,
              }}
            >
              {type?.toUpperCase() || "SD"}
            </Badge>

            {/* Ranking Badge (if in B50) */}
            {ranking !== null && ranking !== undefined && (
              <Badge
                size="lg"
                variant="filled"
                color={isNew ? "teal" : "violet"}
                radius="sm"
                leftSection={<IconTrophy size={14} />}
                style={{
                  position: "absolute",
                  top: 12,
                  left: 12,
                  zIndex: 10,
                  fontSize: 14,
                  fontWeight: 900,
                }}
              >
                #{ranking}
              </Badge>
            )}

            {/* Difficulty & Level overlay */}
            <Box
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                background: "linear-gradient(transparent, rgba(0,0,0,0.8))",
                padding: "24px 12px 12px",
                borderRadius: "0 0 8px 8px",
              }}
            >
              <Group justify="space-between" align="center">
                <Badge
                  size="xl"
                  variant="filled"
                  radius="sm"
                  style={{
                    backgroundColor: difficultyColor,
                    color: "white",
                    fontSize: 16,
                    fontWeight: 900,
                  }}
                >
                  {difficultyName}
                </Badge>
                <Badge
                  size="xl"
                  variant="filled"
                  radius="sm"
                  style={{
                    backgroundColor: "rgba(0,0,0,0.6)",
                    color: "white",
                    fontSize: 16,
                    fontWeight: 900,
                  }}
                >
                  {detailLevelText}
                </Badge>
              </Group>
            </Box>
          </Box>
        </Box>

        {/* Song Title & Artist */}
        <Box px="md" pb="md">
          <Text
            fw={900}
            size="xl"
            c="white"
            lineClamp={2}
            style={{
              textAlign: "center",
              textShadow: "0 2px 8px rgba(0,0,0,0.5)",
              lineHeight: 1.3,
            }}
          >
            {songMetadata?.title || "Unknown Title"}
          </Text>
          <Text
            size="sm"
            c="rgba(255,255,255,0.85)"
            lineClamp={1}
            style={{
              textAlign: "center",
              textShadow: "0 1px 4px rgba(0,0,0,0.5)",
            }}
          >
            {songMetadata?.artist || "Unknown Artist"}
          </Text>
        </Box>
      </Box>

      {/* Score Section */}
      <Box
        p="md"
        style={{
          background: "linear-gradient(180deg, #2a2a4a 0%, #1a1a2e 100%)",
        }}
      >
        {/* Main Score Display */}
        <Box
          style={{
            textAlign: "center",
            padding: "16px 0",
            background: "rgba(255,255,255,0.05)",
            borderRadius: 12,
            marginBottom: 16,
          }}
        >
          <Text
            fw={900}
            size="40px"
            c="#f5d142"
            style={{
              textShadow:
                "0 0 20px rgba(245, 209, 66, 0.5), 0 2px 4px rgba(0,0,0,0.5)",
              letterSpacing: 2,
              lineHeight: 1,
            }}
          >
            {score || "N/A"}
          </Text>
          <Text fw={900} size="28px" mt={4} style={{ letterSpacing: 2 }}>
            {renderRank(rank, { stroke: true })}
          </Text>
        </Box>

        {/* FC & FS Icons with Labels */}
        <Group justify="center" gap="xl" mb="md">
          <Stack align="center" gap={4}>
            <Box
              w={48}
              h={48}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {fc ? (
                <Image src={getIconUrl(fc)} w={48} />
              ) : (
                <Box
                  w={40}
                  h={40}
                  style={{
                    borderRadius: "50%",
                    backgroundColor: "rgba(255,255,255,0.1)",
                    border: "2px dashed rgba(255,255,255,0.3)",
                  }}
                />
              )}
            </Box>
          </Stack>

          <Stack align="center" gap={4}>
            <Box
              w={48}
              h={48}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {fs ? (
                <Image src={getIconUrl(fs)} w={48} />
              ) : (
                <Box
                  w={40}
                  h={40}
                  style={{
                    borderRadius: "50%",
                    backgroundColor: "rgba(255,255,255,0.1)",
                    border: "2px dashed rgba(255,255,255,0.3)",
                  }}
                />
              )}
            </Box>
          </Stack>
        </Group>

        <Divider color="rgba(255,255,255,0.1)" my="sm" />

        {/* Rating & DX Score */}
        <Group justify="space-between" mb="sm">
          <Stack gap={2}>
            <Group gap={6}>
              <Text size="sm" c="dimmed">
                Rating
              </Text>
            </Group>
            <Text fw={900} size="xl" c="white">
              {typeof rating === "number" ? Math.round(rating) : "-"}
            </Text>
          </Stack>

          {
            <Stack gap={2} align="flex-end">
              <Text size="sm" c="dimmed">
                DX Score
              </Text>
              <Text fw={900} size="xl" c="white">
                {dxScore ?? "N/A"}
                {maxDxScore && (
                  <Text span size="sm" c="dimmed">
                    {" "}
                    / {maxDxScore.toLocaleString()}
                  </Text>
                )}
              </Text>
            </Stack>
          }
        </Group>

        <Divider color="rgba(255,255,255,0.1)" my="sm" />

        {/* Song Metadata */}
        <Stack gap="xs">
          {noteDesigner && (
            <Group gap="xs">
              <ThemeIcon size="sm" variant="light" color="pink">
                <IconUser size={14} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                谱师
              </Text>
              <Text size="sm" c="white" fw={600}>
                {noteDesigner}
              </Text>
            </Group>
          )}

          {displayBpm && (
            <Group gap="xs">
              <ThemeIcon size="sm" variant="light" color="orange">
                <IconClock size={14} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                BPM
              </Text>
              <Text size="sm" c="white" fw={600}>
                {displayBpm}
              </Text>
            </Group>
          )}

          {songMetadata?.category && (
            <Group gap="xs">
              <ThemeIcon size="sm" variant="light" color="grape">
                <IconCategory size={14} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                分类
              </Text>
              <Text size="sm" c="white" fw={600}>
                {songMetadata.category}
              </Text>
            </Group>
          )}

          {songMetadata?.version && (
            <Group gap="xs">
              <ThemeIcon size="sm" variant="light" color="cyan">
                <IconVersions size={14} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                版本
              </Text>
              <Text size="sm" c="white" fw={600}>
                {songMetadata.version}
              </Text>
            </Group>
          )}

          <Group gap="xs">
            <ThemeIcon size="sm" variant="light" color="blue">
              <IconMusic size={14} />
            </ThemeIcon>
            <Text size="sm" c="dimmed">
              Music ID
            </Text>
            <Text size="sm" c="white" fw={600}>
              {musicId}
            </Text>
          </Group>
        </Stack>

        <Divider color="rgba(255,255,255,0.1)" my="sm" />

        {/* Search Buttons for Bilibili and YouTube */}
        <Group justify="center" gap="md">
          <Tooltip label="在 Bilibili 搜索谱面确认">
            <ActionIcon
              variant="filled"
              color="pink"
              size="lg"
              radius="md"
              onClick={handleBilibiliSearch}
              style={{
                backgroundColor: "#00A1D6",
              }}
            >
              <IconBrandBilibili size={20} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="在 YouTube 搜索谱面确认">
            <ActionIcon
              variant="filled"
              color="red"
              size="lg"
              radius="md"
              onClick={handleYoutubeSearch}
              style={{
                backgroundColor: "#FF0000",
              }}
            >
              <IconBrandYoutube size={20} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Box>
    </Card>
  );
}
