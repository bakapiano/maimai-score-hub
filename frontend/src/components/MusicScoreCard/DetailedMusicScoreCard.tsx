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

import { DeferredImage } from "../DeferredImage";
import type { DetailedMusicScoreCardProps } from "./types";
import type { ReactNode } from "react";

type DetailViewModel = {
  difficultyColor: string;
  difficultyName: string;
  detailLevelText: string | number;
  coverUrl: string;
  rank: string;
  displayBpm: string | number | null;
  searchQuery: string;
  bilibiliSearchUrl: string;
  youtubeSearchUrl: string;
  isMobile: boolean;
};

type MetadataRowProps = {
  color: string;
  icon: ReactNode;
  label: string;
  value: ReactNode;
};

function isMobileBrowser() {
  return (
    typeof navigator !== "undefined" &&
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    )
  );
}

function openSearchUrl(appUrl: string, webUrl: string, isMobile: boolean) {
  if (isMobile) {
    window.location.href = appUrl;
    setTimeout(() => {
      window.open(webUrl, "_blank");
    }, 500);
    return;
  }
  window.open(webUrl, "_blank");
}

function buildViewModel({
  musicId,
  chartIndex,
  score,
  chartPayload,
  songMetadata,
  bpm,
}: DetailedMusicScoreCardProps): DetailViewModel {
  const difficultyColor = LEVEL_COLORS[chartIndex] || "#888";
  const difficultyName =
    DIFFICULTY_NAMES[chartIndex]?.toUpperCase() || "UNKNOWN";
  const detailLevelText =
    typeof chartPayload?.detailLevel === "number"
      ? chartPayload.detailLevel.toFixed(1)
      : chartPayload?.detailLevel ?? "?";
  const searchQuery = `${songMetadata?.title || ""} ${difficultyName}`.trim();

  return {
    difficultyColor,
    difficultyName,
    detailLevelText,
    coverUrl: getCoverUrl(musicId),
    rank: getRankFromScore(score),
    displayBpm: bpm ?? songMetadata?.bpm ?? null,
    searchQuery,
    bilibiliSearchUrl: `https://search.bilibili.com/all?keyword=${encodeURIComponent(
      searchQuery,
    )}`,
    youtubeSearchUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(
      searchQuery,
    )}`,
    isMobile: isMobileBrowser(),
  };
}

function CoverHeader({
  props,
  view,
}: {
  props: DetailedMusicScoreCardProps;
  view: DetailViewModel;
}) {
  const { type, songMetadata, ranking, isNew } = props;

  return (
    <Box
      style={{
        position: "relative",
        background: `linear-gradient(180deg, ${view.difficultyColor}cc 0%, ${view.difficultyColor}88 100%)`,
      }}
    >
      <Box
        p="md"
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Box style={{ position: "relative" }}>
          <DeferredImage
            src={view.coverUrl}
            w={DETAILED_COVER_SIZE}
            h={DETAILED_COVER_SIZE}
            radius="md"
            style={{
              border: `3px solid white`,
              boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            }}
          />
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
                  backgroundColor: view.difficultyColor,
                  color: "white",
                  fontSize: 16,
                  fontWeight: 900,
                }}
              >
                {view.difficultyName}
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
                {view.detailLevelText}
              </Badge>
            </Group>
          </Box>
        </Box>
      </Box>
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
  );
}

function StatusIcon({ icon }: { icon: string | null }) {
  return (
    <Box
      w={48}
      h={48}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {icon ? (
        <Image src={getIconUrl(icon)} w={48} referrerPolicy="no-referrer" />
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
  );
}

function MainScore({
  score,
  rank,
}: {
  score: string | null;
  rank: string;
}) {
  return (
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
  );
}

function ScoreStats({
  rating,
  dxScore,
  maxDxScore,
}: Pick<DetailedMusicScoreCardProps, "rating" | "dxScore" | "maxDxScore">) {
  return (
    <Group justify="space-between" mb="sm">
      <Stack gap={2}>
        <Text size="sm" c="dimmed">
          Rating
        </Text>
        <Text fw={900} size="xl" c="white">
          {typeof rating === "number" ? Math.round(rating) : "-"}
        </Text>
      </Stack>
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
    </Group>
  );
}

function MetadataRow({ color, icon, label, value }: MetadataRowProps) {
  return (
    <Group gap="xs">
      <ThemeIcon size="sm" variant="light" color={color}>
        {icon}
      </ThemeIcon>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" c="white" fw={600}>
        {value}
      </Text>
    </Group>
  );
}

function SongMetadataRows({
  props,
  displayBpm,
}: {
  props: DetailedMusicScoreCardProps;
  displayBpm: string | number | null;
}) {
  const { musicId, noteDesigner, songMetadata } = props;

  return (
    <Stack gap="xs">
      {noteDesigner && (
        <MetadataRow
          color="pink"
          icon={<IconUser size={14} />}
          label="谱师"
          value={noteDesigner}
        />
      )}
      {displayBpm && (
        <MetadataRow
          color="orange"
          icon={<IconClock size={14} />}
          label="BPM"
          value={displayBpm}
        />
      )}
      {songMetadata?.category && (
        <MetadataRow
          color="grape"
          icon={<IconCategory size={14} />}
          label="分类"
          value={songMetadata.category}
        />
      )}
      {songMetadata?.version && (
        <MetadataRow
          color="cyan"
          icon={<IconVersions size={14} />}
          label="版本"
          value={songMetadata.version}
        />
      )}
      <MetadataRow
        color="blue"
        icon={<IconMusic size={14} />}
        label="Music ID"
        value={musicId}
      />
    </Stack>
  );
}

function SearchActions({ view }: { view: DetailViewModel }) {
  const bilibiliAppUrl = `bilibili://search?keyword=${encodeURIComponent(
    view.searchQuery,
  )}`;
  const youtubeAppUrl = `youtube://results?search_query=${encodeURIComponent(
    view.searchQuery,
  )}`;

  return (
    <Group justify="center" gap="md">
      <Tooltip label="在 Bilibili 搜索谱面确认">
        <ActionIcon
          variant="filled"
          color="pink"
          size="lg"
          radius="md"
          onClick={() =>
            openSearchUrl(
              bilibiliAppUrl,
              view.bilibiliSearchUrl,
              view.isMobile,
            )
          }
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
          onClick={() =>
            openSearchUrl(
              youtubeAppUrl,
              view.youtubeSearchUrl,
              view.isMobile,
            )
          }
          style={{
            backgroundColor: "#FF0000",
          }}
        >
          <IconBrandYoutube size={20} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

function ScoreSection({
  props,
  view,
}: {
  props: DetailedMusicScoreCardProps;
  view: DetailViewModel;
}) {
  const { score, fs, fc, rating, dxScore, maxDxScore } = props;

  return (
    <Box
      p="md"
      style={{
        background: "linear-gradient(180deg, #2a2a4a 0%, #1a1a2e 100%)",
      }}
    >
      <MainScore score={score} rank={view.rank} />
      <Group justify="center" gap="xl" mb="md">
        <Stack align="center" gap={4}>
          <StatusIcon icon={fc} />
        </Stack>
        <Stack align="center" gap={4}>
          <StatusIcon icon={fs} />
        </Stack>
      </Group>
      <Divider color="rgba(255,255,255,0.1)" my="sm" />
      <ScoreStats rating={rating} dxScore={dxScore} maxDxScore={maxDxScore} />
      <Divider color="rgba(255,255,255,0.1)" my="sm" />
      <SongMetadataRows props={props} displayBpm={view.displayBpm} />
      <Divider color="rgba(255,255,255,0.1)" my="sm" />
      <SearchActions view={view} />
    </Box>
  );
}

/**
 * Detailed Music Score Card for modal/popup display.
 */
export function DetailedMusicScoreCard(props: DetailedMusicScoreCardProps) {
  const view = buildViewModel(props);

  return (
    <Card
      withBorder
      padding={0}
      style={{
        overflow: "hidden",
        backgroundColor: "#1a1a2e",
        border: `4px solid ${view.difficultyColor}`,
        maxWidth: 380,
        width: "100%",
      }}
    >
      <CoverHeader props={props} view={view} />
      <ScoreSection props={props} view={view} />
    </Card>
  );
}
