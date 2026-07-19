import { Badge, Box, Card, Group, Text } from "@mantine/core";
import type { ScoreChange } from "@maimai-score-hub/shared";
import { useState, type CSSProperties } from "react";

import { DeferredImage } from "../../components/DeferredImage";
import {
  LEVEL_COLORS,
  getCoverUrl,
  renderRank,
  renderScoreStatusIcon,
  type DetailedMusicScoreCardProps,
} from "../../components/MusicScoreCard";
import { ScoreDetailModal } from "../../components/ScoreDetailModal";
import type { MusicRow } from "../../types/music";
import { getAchievementRank } from "../../utils/achievementRank";
import {
  getDxStarForScore,
  getMaxDxScoreFromNotes,
  parseDxScore,
} from "../../utils/dxScore";
import type { ScoreHistoryDisplayItem } from "./scoreHistoryTime";
import classes from "./ScoreHistoryTab.module.css";

const ASSET_BASE = "/mai/pic";
const ID_COLORS = ["#81d955", "#f5bd15", "#ff818d", "#9f51dc", "#8a00e2"];

function localTime(value: string) {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function hasValue(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "";
}

function isNonZero(value: number | null, epsilon = Number.EPSILON) {
  return value !== null && Math.abs(value) >= epsilon;
}

function EmptyStatusDot() {
  return <Box className={classes.emptyStatusDot} />;
}

function formatAchievement(value: string) {
  const parsed = Number.parseFloat(value.replace("%", ""));
  return Number.isFinite(parsed) ? parsed.toFixed(4) : value;
}

function formatSignedAchievement(value: number) {
  const normalized = Math.abs(value) < 0.00005 ? 0 : value;
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(4)}`;
}

function formatSignedInteger(value: number) {
  const normalized = Math.round(value);
  return `${normalized >= 0 ? "+" : ""}${normalized.toLocaleString("en-US")}`;
}

function compactDecimal(value: number) {
  const text = value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return text.includes(".") ? text : `${text}.0`;
}

function formatRating(value: number) {
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : compactDecimal(value);
}

function formatSignedRating(value: number) {
  return `${value >= 0 ? "+" : ""}${formatRating(value)}`;
}

function DxStarMark({ value }: { value: number }) {
  if (value <= 0) {
    return null;
  }
  return (
    <img
      src={`${ASSET_BASE}/UI_GAM_Gauge_DXScoreIcon_0${value}.png`}
      alt={`${value} 星`}
      className={classes.dxStarImage}
    />
  );
}

function AchievementRank({
  before,
  after,
}: {
  before: ScoreChange["before"]["score"];
  after: ScoreChange["after"]["score"];
}) {
  const beforeRank = getAchievementRank(before);
  const afterRank = getAchievementRank(after);
  if (!afterRank) {
    return null;
  }
  const changed = beforeRank !== null && beforeRank !== afterRank;
  return (
    <Group wrap="nowrap" className={classes.metricStatus}>
      {changed
        ? renderRank(beforeRank, { compact: true, stroke: true, width: 48 })
        : null}
      {changed ? <Text className={classes.inlineArrow}>→</Text> : null}
      {renderRank(afterRank, { compact: true, stroke: true, width: 48 })}
    </Group>
  );
}

function DxStarChange({
  before,
  after,
  maxDxScore,
}: {
  before: ScoreChange["before"]["dxScore"];
  after: ScoreChange["after"]["dxScore"];
  maxDxScore: number | null;
}) {
  const beforeStar = getDxStarForScore(parseDxScore(before), maxDxScore);
  const afterStar = getDxStarForScore(parseDxScore(after), maxDxScore);
  if (afterStar === null || afterStar <= 0) {
    return null;
  }
  const changed =
    beforeStar !== null && beforeStar > 0 && beforeStar !== afterStar;
  return (
    <Group wrap="nowrap" className={classes.metricStatus}>
      {changed ? <DxStarMark value={beforeStar} /> : null}
      {changed ? <Text className={classes.inlineArrow}>→</Text> : null}
      <DxStarMark value={afterStar} />
    </Group>
  );
}

function AchievementMetricRow({ change }: { change: ScoreChange }) {
  const achievement = hasValue(change.after.score)
    ? formatAchievement(change.after.score)
    : null;
  const achievementDelta =
    hasValue(change.before.score) && change.changedFields.includes("score")
      ? change.achievementDelta
      : null;

  return (
    <Group
      wrap="nowrap"
      className={`${classes.metricRow} ${classes.achievementRow}`}
    >
      {achievement !== null ? (
        <>
          <Text className={classes.metricValue}>
            {achievement}%
            {isNonZero(achievementDelta, 0.00005) ? (
              <span className={classes.metricDelta}>
                ({formatSignedAchievement(achievementDelta!)}%)
              </span>
            ) : null}
          </Text>
          <AchievementRank
            before={change.before.score}
            after={change.after.score}
          />
        </>
      ) : (
        <Text className={classes.metricValue}>N/A</Text>
      )}
    </Group>
  );
}

function DxScoreMetricRow({
  change,
  maxDxScore,
}: {
  change: ScoreChange;
  maxDxScore: number | null;
}) {
  const dxScore = parseDxScore(change.after.dxScore);
  const dxScoreDelta =
    hasValue(change.before.dxScore) && change.changedFields.includes("dxScore")
      ? change.dxScoreDelta
      : null;

  return (
    <Group
      wrap="nowrap"
      className={`${classes.metricRow} ${classes.dxMetricRow}`}
    >
      {dxScore !== null ? (
        <>
          <Text className={classes.metricValue}>
            {dxScore.toLocaleString("en-US")}
            {isNonZero(dxScoreDelta) ? (
              <span className={classes.metricDelta}>
                ({formatSignedInteger(dxScoreDelta!)})
              </span>
            ) : null}
          </Text>
          <DxStarChange
            before={change.before.dxScore}
            after={change.after.dxScore}
            maxDxScore={maxDxScore}
          />
          <Group wrap="nowrap" className={classes.currentStatuses}>
            <CurrentStatusChange
              before={change.before.fc}
              after={change.after.fc}
            />
            <CurrentStatusChange
              before={change.before.fs}
              after={change.after.fs}
            />
          </Group>
        </>
      ) : (
        <Text className={classes.metricValue}>N/A</Text>
      )}
    </Group>
  );
}

function CurrentStatusChange({
  before,
  after,
}: {
  before: string | null | undefined;
  after: string | null | undefined;
}) {
  if (!hasValue(after)) {
    return null;
  }
  const beforeValue = hasValue(before) ? before : null;
  const changed = beforeValue?.toLowerCase() !== after.toLowerCase();
  return (
    <Group wrap="nowrap" className={classes.currentStatusChange}>
      {changed ? (
        beforeValue ? (
          renderScoreStatusIcon(beforeValue, { size: 24 })
        ) : (
          <EmptyStatusDot />
        )
      ) : null}
      {changed ? <Text className={classes.inlineArrow}>→</Text> : null}
      {renderScoreStatusIcon(after, { size: 24 })}
    </Group>
  );
}

function ScoreChangeSummary({
  change,
  maxDxScore,
}: {
  change: ScoreChange;
  maxDxScore: number | null;
}) {
  return (
    <Box className={classes.changeSummary}>
      <AchievementMetricRow change={change} />
      <DxScoreMetricRow change={change} maxDxScore={maxDxScore} />
    </Box>
  );
}

function formatLevelText(level: string | number | null | undefined) {
  return typeof level === "number" ? level.toFixed(1) : (level ?? "?");
}

function hasRatingChange(change: ScoreChange) {
  return (
    change.changedFields.includes("rating") &&
    change.before.rating !== null &&
    change.before.rating !== undefined &&
    change.after.rating !== null &&
    change.after.rating !== undefined &&
    change.before.rating !== change.after.rating
  );
}

function FooterRating({
  change,
  levelText,
}: {
  change: ScoreChange;
  levelText: string;
}) {
  const rating =
    change.after.rating !== null && change.after.rating !== undefined
      ? formatRating(change.after.rating)
      : "N/A";
  const showDelta = hasRatingChange(change) && isNonZero(change.ratingDelta);
  return (
    <Badge
      size="xs"
      color="gray"
      variant="filled"
      radius="sm"
      tt="none"
      className={classes.footerRatingBadge}
    >
      {levelText} → {rating}
      {showDelta ? (
        <span className={classes.metricDelta}>
          ({formatSignedRating(change.ratingDelta!)})
        </span>
      ) : null}
    </Badge>
  );
}

function HistoryCardMetadata({ change }: { change: ScoreChange }) {
  const isDx = change.type === "dx";
  const idColor = ID_COLORS[change.chartIndex] ?? "#555";
  return (
    <Group gap={3} wrap="nowrap" className={classes.cardMetadata}>
      <img
        className={classes.cardTypeBadge}
        src={`${ASSET_BASE}/${isDx ? "DX.png" : "SD.png"}`}
        alt={isDx ? "DX" : "SD"}
      />
      <Badge
        size="xs"
        variant="filled"
        radius="sm"
        tt="none"
        className={`${classes.cardMetaBadge} ${classes.musicIdBadge}`}
        style={{ color: idColor }}
      >
        #{change.musicId}
      </Badge>
    </Group>
  );
}

function HistoryCardFooter({
  change,
  levelText,
}: {
  change: ScoreChange;
  levelText: string;
}) {
  const isNew = change.changedFields.includes("newChart");
  return (
    <Group
      justify="space-between"
      gap="xs"
      wrap="nowrap"
      className={classes.cardFooter}
    >
      <Group gap={5} wrap="nowrap" className={classes.footerInfo}>
        <HistoryCardMetadata change={change} />
        <FooterRating change={change} levelText={levelText} />
      </Group>
      <Group gap={5} wrap="nowrap" className={classes.footerRight}>
        {isNew ? (
          <Badge
            size="xs"
            color="cyan"
            variant="light"
            tt="none"
            className={`${classes.footerBadge} ${classes.newBadge}`}
          >
            NEW
          </Badge>
        ) : null}
        <Text size="xs" c="dimmed" className={classes.cardTime}>
          {localTime(change.observedAt)}
        </Text>
      </Group>
    </Group>
  );
}

function ScoreHistoryCard({
  item,
  music,
  onClick,
}: {
  item: ScoreHistoryDisplayItem;
  music?: MusicRow;
  onClick: () => void;
}) {
  const { change } = item;
  const chart = music?.charts?.[change.chartIndex];
  const maxDxScore = getMaxDxScoreFromNotes(chart?.notes);
  const difficultyColor = LEVEL_COLORS[change.chartIndex] ?? "#888";
  const levelText = formatLevelText(chart?.detailLevel ?? chart?.level);
  const title = music?.title ?? `未知曲目 #${change.musicId}`;

  return (
    <Card
      padding={0}
      className={classes.historyCard}
      role="button"
      tabIndex={0}
      aria-label={`查看 ${title} 的成绩详情`}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      style={{ "--history-level-color": difficultyColor } as CSSProperties}
    >
      <Box className={classes.cardHero}>
        <DeferredImage
          src={getCoverUrl(change.musicId)}
          alt={title}
          className={classes.cardCover}
        />
        <Group gap={5} wrap="nowrap" className={classes.cardTitleRow}>
          <Text
            fw={800}
            lineClamp={1}
            title={title}
            className={classes.cardTitle}
          >
            {title}
          </Text>
        </Group>

        <Box className={classes.cardChanges}>
          <ScoreChangeSummary change={change} maxDxScore={maxDxScore} />
        </Box>
      </Box>
      <HistoryCardFooter change={change} levelText={levelText} />
    </Card>
  );
}

export function ScoreHistoryCards({
  items,
  musicMap,
}: {
  items: ScoreHistoryDisplayItem[];
  musicMap: Map<string, MusicRow>;
}) {
  const [selectedScore, setSelectedScore] =
    useState<DetailedMusicScoreCardProps | null>(null);

  const openScoreDetail = (item: ScoreHistoryDisplayItem, music?: MusicRow) => {
    const { change } = item;
    const chart = music?.charts?.[change.chartIndex];
    setSelectedScore({
      musicId: change.musicId,
      chartIndex: change.chartIndex,
      type: change.type,
      rating: change.after.rating ?? null,
      score: change.after.score ?? null,
      dxScore: change.after.dxScore ?? null,
      fc: change.after.fc ?? null,
      fs: change.after.fs ?? null,
      chartPayload: chart ?? null,
      songMetadata: music
        ? {
            title: music.title,
            artist: music.artist,
            category: music.category,
            isNew: music.isNew,
            bpm: music.bpm,
            version: music.version,
          }
        : null,
      bpm:
        typeof music?.bpm === "number"
          ? music.bpm
          : Number.parseInt(String(music?.bpm ?? ""), 10) || null,
      noteDesigner: chart?.charter ?? null,
      isNew: music?.isNew ?? null,
      maxDxScore: getMaxDxScoreFromNotes(chart?.notes),
    });
  };

  return (
    <>
      <ScoreDetailModal
        opened={selectedScore !== null}
        onClose={() => setSelectedScore(null)}
        scoreData={selectedScore}
      />
      <Box className={classes.cardGrid}>
        {items.map((item) => {
          const music = musicMap.get(item.change.musicId);
          return (
            <ScoreHistoryCard
              key={item.change.id}
              item={item}
              music={music}
              onClick={() => openScoreDetail(item, music)}
            />
          );
        })}
      </Box>
    </>
  );
}
