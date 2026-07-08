import {
  ActionIcon,
  Badge,
  Box,
  Group,
  Image,
  NumberFormatter,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconBrandBilibili,
  IconBrandYoutube,
  IconCategory,
  IconClock,
  IconHash,
  IconUser,
  IconVersions,
} from "@tabler/icons-react";
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  DIFFICULTY_NAMES,
  LEVEL_COLORS,
  getCoverUrl,
  getIconUrl,
  getRank,
  parseScore,
  type DetailedMusicScoreCardProps,
} from "./MusicScoreCard";
import { DeferredImage } from "./DeferredImage";
import classes from "./ScoreDetailModal.module.css";

const FALLBACK_COVER =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><rect width='100%25' height='100%25' fill='%23222931'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%238a8f98' font-size='12'>Cover</text></svg>";
const ASSET_BASE = "/mai/pic";

const RANK_ASSET: Record<string, string> = {
  "SSS+": "UI_TTR_Rank_SSSp.png",
  SSS: "UI_TTR_Rank_SSS.png",
  "SS+": "UI_TTR_Rank_SSp.png",
  SS: "UI_TTR_Rank_SS.png",
  "S+": "UI_TTR_Rank_Sp.png",
  S: "UI_TTR_Rank_S.png",
  AAA: "UI_TTR_Rank_AAA.png",
  AA: "UI_TTR_Rank_AA.png",
  A: "UI_TTR_Rank_A.png",
  BBB: "UI_TTR_Rank_BBB.png",
  BB: "UI_TTR_Rank_BB.png",
  B: "UI_TTR_Rank_B.png",
  C: "UI_TTR_Rank_C.png",
  D: "UI_TTR_Rank_D.png",
};

type MetadataItemView = {
  label: string;
  value: ReactNode;
  icon: ReactNode;
};

function parseAchievement(value: string | null) {
  const parsed = parseScore(value);
  if (parsed === null || parsed > 101.5) {
    return null;
  }
  return parsed;
}

function formatAchievement(value: string | null) {
  const parsed = parseAchievement(value);
  if (parsed === null) {
    return value || "N/A";
  }
  return `${parsed.toFixed(4)}%`;
}

function formatTypeLabel(type: string) {
  if (type === "standard") {
    return "标准";
  }
  if (type === "dx") {
    return "DX";
  }
  if (type === "utage") {
    return "宴";
  }
  return type.toUpperCase();
}

function getDetailLevelText(scoreData: DetailedMusicScoreCardProps) {
  const detailLevel = scoreData.chartPayload?.detailLevel;
  if (typeof detailLevel === "number") {
    return detailLevel.toFixed(1);
  }
  return detailLevel ?? scoreData.chartPayload?.level ?? "?";
}

function getBpmDisplay(scoreData: DetailedMusicScoreCardProps) {
  return scoreData.bpm ?? scoreData.songMetadata?.bpm ?? null;
}

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
    window.setTimeout(() => {
      window.open(webUrl, "_blank");
    }, 500);
    return;
  }
  window.open(webUrl, "_blank");
}

function getSearchQuery(
  scoreData: DetailedMusicScoreCardProps,
  difficultyName: string,
) {
  return `${scoreData.songMetadata?.title || scoreData.musicId} ${difficultyName}`.trim();
}

function parseDxScore(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function getDxStar(dxPercent: number) {
  if (dxPercent <= 85) {
    return 0;
  }
  if (dxPercent <= 90) {
    return 1;
  }
  if (dxPercent <= 93) {
    return 2;
  }
  if (dxPercent <= 95) {
    return 3;
  }
  if (dxPercent <= 97) {
    return 4;
  }
  return 5;
}

function getVisibleMetadataItems(
  scoreData: DetailedMusicScoreCardProps,
): MetadataItemView[] {
  const items: Array<{
    label: string;
    value: ReactNode | null | undefined;
    icon: ReactNode;
  }> = [
    {
      label: "谱师",
      value: scoreData.noteDesigner ?? scoreData.chartPayload?.charter,
      icon: <IconUser size={14} />,
    },
    {
      label: "BPM",
      value: getBpmDisplay(scoreData),
      icon: <IconClock size={14} />,
    },
    {
      label: "分类",
      value: scoreData.songMetadata?.category,
      icon: <IconCategory size={14} />,
    },
    {
      label: "版本",
      value: scoreData.songMetadata?.version,
      icon: <IconVersions size={14} />,
    },
  ];

  return items.filter(
    (item): item is MetadataItemView =>
      item.value !== null && item.value !== undefined && item.value !== "",
  );
}

function useMeasuredCoverSize(deps: unknown[]) {
  const songInfoRef = useRef<HTMLDivElement | null>(null);
  const [coverSize, setCoverSize] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = songInfoRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const height = Math.round(element.getBoundingClientRect().height);
      if (height > 0) {
        setCoverSize((current) => (current === height ? current : height));
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { coverSize, songInfoRef };
}

function MetadataItem({ icon, label, value }: MetadataItemView) {
  const tooltipLabel =
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : undefined;

  return (
    <Box className={classes.metadataItem}>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <ThemeIcon size="sm" variant="light" color="gray">
          {icon}
        </ThemeIcon>
        <Stack gap={1} className={classes.fieldText}>
          <Text size="xs" c="dimmed">
            {label}
          </Text>
          <Tooltip
            label={tooltipLabel}
            disabled={!tooltipLabel}
            openDelay={250}
            withinPortal
          >
            <Text size="sm" fw={400} className={classes.fieldValue}>
              {value}
            </Text>
          </Tooltip>
        </Stack>
      </Group>
    </Box>
  );
}

function ScoreStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <Paper className={classes.statTile} withBorder>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={400} className={classes.statValue}>
        {value}
      </Text>
      {detail ? (
        <Text size="xs" c="dimmed" className={classes.statDetail}>
          {detail}
        </Text>
      ) : null}
    </Paper>
  );
}

function SummaryHeader({
  coverSize,
  difficultyColor,
  difficultyName,
  detailLevelText,
  levelText,
  scoreData,
  songInfoRef,
}: {
  coverSize: number | null;
  difficultyColor: string;
  difficultyName: string;
  detailLevelText: string | number;
  levelText: string | number;
  scoreData: DetailedMusicScoreCardProps;
  songInfoRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <Group wrap="nowrap" align="flex-start" className={classes.summaryHeader}>
      <Box
        className={classes.coverFrame}
        style={coverSize ? { width: coverSize, height: coverSize } : undefined}
      >
        <DeferredImage
          src={getCoverUrl(scoreData.musicId)}
          fallbackSrc={FALLBACK_COVER}
          alt={scoreData.songMetadata?.title || scoreData.musicId}
          className={classes.cover}
        />
      </Box>
      <Stack gap="xs" className={classes.songInfo} ref={songInfoRef}>
        <Group gap={6}>
          <Badge variant="filled" color={scoreData.type === "dx" ? "orange" : "blue"}>
            {formatTypeLabel(scoreData.type)}
          </Badge>
          {scoreData.songMetadata?.isNew ? (
            <Badge variant="light" color="teal">
              新曲 / B15
            </Badge>
          ) : null}
          <Badge variant="light" color="gray" leftSection={<IconHash size={12} />}>
            {scoreData.musicId}
          </Badge>
        </Group>
        <Group gap="xs" align="flex-start" className={classes.songTitleRow}>
          <Stack gap={2} className={classes.songTitleText}>
            <Title order={3} className={classes.songTitle}>
              {scoreData.songMetadata?.title || "Unknown Title"}
            </Title>
            {scoreData.songMetadata?.artist ? (
              <Text size="sm" c="dimmed" lineClamp={1}>
                {scoreData.songMetadata.artist}
              </Text>
            ) : null}
          </Stack>
        </Group>
        <Group gap="xs">
          <Badge
            className={classes.levelBadge}
            style={{ "--difficulty-color": difficultyColor } as CSSProperties}
          >
            {difficultyName}
          </Badge>
          <Badge variant="default">{levelText}</Badge>
          {detailLevelText !== levelText ? (
            <Badge variant="light" color="gray">
              定数 {detailLevelText}
            </Badge>
          ) : null}
        </Group>
      </Stack>
    </Group>
  );
}

function AchievementRow({
  rank,
  scoreData,
}: {
  rank: string | null;
  scoreData: DetailedMusicScoreCardProps;
}) {
  const rankAsset = rank ? RANK_ASSET[rank] : null;

  return (
    <Group className={classes.achievementRow} align="center" gap="sm" wrap="nowrap">
      <Group gap="sm" wrap="nowrap" className={classes.achievementMain}>
        {rankAsset ? (
          <Image
            src={`${ASSET_BASE}/${rankAsset}`}
            alt={rank ?? "评级"}
            className={classes.rankImage}
          />
        ) : null}
        <Text fw={400} className={classes.achievementText}>
          {formatAchievement(scoreData.score)}
        </Text>
      </Group>
      <Group gap={0} wrap="nowrap" className={classes.statusGroup}>
        <Box className={classes.statusIcon}>
          {scoreData.fc ? <Image src={getIconUrl(scoreData.fc)} w={32} h={32} /> : null}
        </Box>
        <Box className={classes.statusIcon}>
          {scoreData.fs ? <Image src={getIconUrl(scoreData.fs)} w={32} h={32} /> : null}
        </Box>
      </Group>
    </Group>
  );
}

function DxScoreValue({
  dxScore,
  dxStar,
  maxDxScore,
}: {
  dxScore: number | null;
  dxStar: number | null;
  maxDxScore: number | null;
}) {
  if (dxScore === null) {
    return "N/A";
  }

  return (
    <Group gap="xs" wrap="nowrap" className={classes.dxScoreLine}>
      <Text span inherit>
        <NumberFormatter value={dxScore} thousandSeparator />
        {maxDxScore !== null ? (
          <>
            {" "}
            / <NumberFormatter value={maxDxScore} thousandSeparator />
          </>
        ) : null}
      </Text>
      {dxStar !== null && dxStar > 0 ? (
        <Image
          src={`${ASSET_BASE}/UI_GAM_Gauge_DXScoreIcon_0${dxStar}.png`}
          alt={`${dxStar} 星`}
          className={classes.dxStarIcon}
        />
      ) : null}
    </Group>
  );
}

function StatsGrid({
  dxScore,
  dxStar,
  maxDxScore,
  scoreData,
}: {
  dxScore: number | null;
  dxStar: number | null;
  maxDxScore: number | null;
  scoreData: DetailedMusicScoreCardProps;
}) {
  return (
    <SimpleGrid cols={{ base: 2, xs: 2 }} spacing="sm">
      <ScoreStat
        label="DX Rating"
        value={
          typeof scoreData.rating === "number" ? Math.round(scoreData.rating) : "-"
        }
      />
      <ScoreStat
        label="DX 分数"
        value={
          <DxScoreValue
            dxScore={dxScore}
            dxStar={dxStar}
            maxDxScore={maxDxScore}
          />
        }
      />
    </SimpleGrid>
  );
}

function MetadataGrid({ items }: { items: MetadataItemView[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <SimpleGrid cols={{ base: 2, xs: 4 }} spacing="xs">
      {items.map((item) => (
        <MetadataItem
          key={item.label}
          icon={item.icon}
          label={item.label}
          value={item.value}
        />
      ))}
    </SimpleGrid>
  );
}

function SearchActions({
  difficultyName,
  scoreData,
}: {
  difficultyName: string;
  scoreData: DetailedMusicScoreCardProps;
}) {
  const query = getSearchQuery(scoreData, difficultyName);
  const bilibiliWebUrl = `https://search.bilibili.com/all?keyword=${encodeURIComponent(
    query,
  )}`;
  const youtubeWebUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(
    query,
  )}`;
  const bilibiliAppUrl = `bilibili://search?keyword=${encodeURIComponent(
    query,
  )}`;
  const youtubeAppUrl = `youtube://results?search_query=${encodeURIComponent(
    query,
  )}`;
  const isMobile = isMobileBrowser();

  return (
    <Group gap="xs" justify="flex-start" wrap="nowrap">
      <Tooltip label="在 Bilibili 搜索谱面确认">
        <ActionIcon
          variant="filled"
          radius="md"
          aria-label="在 Bilibili 搜索谱面确认"
          onClick={() => openSearchUrl(bilibiliAppUrl, bilibiliWebUrl, isMobile)}
          style={{ backgroundColor: "#00a1d6" }}
        >
          <IconBrandBilibili size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="在 YouTube 搜索谱面确认">
        <ActionIcon
          variant="filled"
          radius="md"
          aria-label="在 YouTube 搜索谱面确认"
          onClick={() => openSearchUrl(youtubeAppUrl, youtubeWebUrl, isMobile)}
          style={{ backgroundColor: "#ff0000" }}
        >
          <IconBrandYoutube size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

export function ScoreVerificationSection({
  scoreData,
}: {
  scoreData: DetailedMusicScoreCardProps;
}) {
  const difficultyName =
    DIFFICULTY_NAMES[scoreData.chartIndex]?.toUpperCase() || "UNKNOWN";

  return (
    <Stack gap="sm" className={classes.verificationSection}>
      <Group justify="space-between" align="center" gap="xs">
        <Text fw={700}>铺面确认</Text>
        <SearchActions difficultyName={difficultyName} scoreData={scoreData} />
      </Group>
    </Stack>
  );
}

export function ScoreSummary({
  scoreData,
  maxDxScore,
}: {
  scoreData: DetailedMusicScoreCardProps;
  maxDxScore: number | null;
}) {
  const { coverSize, songInfoRef } = useMeasuredCoverSize([
    scoreData.musicId,
    scoreData.chartIndex,
  ]);
  const difficultyColor = LEVEL_COLORS[scoreData.chartIndex] || "#888";
  const difficultyName =
    DIFFICULTY_NAMES[scoreData.chartIndex]?.toUpperCase() || "UNKNOWN";
  const detailLevelText = getDetailLevelText(scoreData);
  const levelText = scoreData.chartPayload?.level ?? detailLevelText;
  const achievement = parseAchievement(scoreData.score);
  const rank = achievement !== null ? getRank(achievement) : null;
  const dxScore = parseDxScore(scoreData.dxScore);
  const dxPercent =
    dxScore !== null && maxDxScore !== null && maxDxScore > 0
      ? (dxScore / maxDxScore) * 100
      : null;
  const dxStar = dxPercent !== null ? getDxStar(dxPercent) : null;

  return (
    <Box
      className={classes.summary}
      style={{ "--difficulty-color": difficultyColor } as CSSProperties}
    >
      <SummaryHeader
        coverSize={coverSize}
        difficultyColor={difficultyColor}
        difficultyName={difficultyName}
        detailLevelText={detailLevelText}
        levelText={levelText}
        scoreData={scoreData}
        songInfoRef={songInfoRef}
      />
      <AchievementRow rank={rank} scoreData={scoreData} />
      <StatsGrid
        dxScore={dxScore}
        dxStar={dxStar}
        maxDxScore={maxDxScore}
        scoreData={scoreData}
      />
      <MetadataGrid items={getVisibleMetadataItems(scoreData)} />
    </Box>
  );
}
