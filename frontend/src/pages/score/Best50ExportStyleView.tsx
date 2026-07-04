import { type CSSProperties, useMemo } from "react";

import type { MusicChartPayload, MusicRow } from "../../types/music";
import type { SyncScore } from "../../types/syncScore";
import { getCoverUrl } from "../../components/MusicScoreCard";
import classes from "./Best50ExportStyleView.module.css";

const ASSET_BASE = "/mai/pic";

const DIFF_CARD_ASSETS = [
  "b50_score_basic.png",
  "b50_score_advanced.png",
  "b50_score_expert.png",
  "b50_score_master.png",
  "b50_score_remaster.png",
];

const ID_COLORS = [
  "#81d955",
  "#f5bd15",
  "#ff818d",
  "#9f51dc",
  "#8a00e2",
];

const FC_ASSET: Record<string, string> = {
  fc: "UI_MSS_MBase_Icon_FC.png",
  fcp: "UI_MSS_MBase_Icon_FCp.png",
  ap: "UI_MSS_MBase_Icon_AP.png",
  app: "UI_MSS_MBase_Icon_APp.png",
};

const FS_ASSET: Record<string, string> = {
  fs: "UI_MSS_MBase_Icon_FS.png",
  fsp: "UI_MSS_MBase_Icon_FSp.png",
  fsd: "UI_MSS_MBase_Icon_FSD.png",
  fsdp: "UI_MSS_MBase_Icon_FSDp.png",
};

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

type ChartLookup = MusicChartPayload & {
  musicId: string;
  chartIndex: number;
};

type RatingSummaryLike = {
  newTop: SyncScore[];
  oldTop: SyncScore[];
  newSum: number;
  oldSum: number;
  totalSum: number;
};

type Props = {
  ratingSummary: RatingSummaryLike;
  musicMap: Map<string, MusicRow>;
  chartMap: Map<number, ChartLookup>;
  onScoreClick: (score: SyncScore, ranking: number, isNew: boolean) => void;
};

type ExportCard = {
  score: SyncScore;
  ranking: number;
  isNew: boolean;
  musicId: string;
  chartIndex: number;
  type: string;
  scoreText: string | null;
  dxScoreText: string | null;
  dxStar: number | null;
  rating: number | null;
  fc: string | null;
  fs: string | null;
  title: string;
  detailLevelText: string;
};

type Best50ExportStyleCardPreviewProps = {
  score: SyncScore;
  musicMap: Map<string, MusicRow>;
  chartMap: Map<number, ChartLookup>;
};

function asset(filename: string) {
  return `${ASSET_BASE}/${filename}`;
}

function parseScore(score: string | null) {
  if (!score || typeof score !== "string") return null;
  const parsed = parseFloat(score.replace("%", ""));
  return Number.isNaN(parsed) ? null : parsed;
}

function getRank(scoreVal: number) {
  if (scoreVal >= 100.5) return "SSS+";
  if (scoreVal >= 100) return "SSS";
  if (scoreVal >= 99.5) return "SS+";
  if (scoreVal >= 99) return "SS";
  if (scoreVal >= 98) return "S+";
  if (scoreVal >= 97) return "S";
  if (scoreVal >= 94) return "AAA";
  if (scoreVal >= 90) return "AA";
  if (scoreVal >= 80) return "A";
  if (scoreVal >= 75) return "BBB";
  if (scoreVal >= 70) return "BB";
  if (scoreVal >= 60) return "B";
  if (scoreVal >= 50) return "C";
  return "D";
}

function getRankFromScore(score: string | null) {
  const parsed = parseScore(score);
  return parsed !== null ? getRank(parsed) : null;
}

function getCardTextColor(chartIndex: number) {
  return chartIndex === 4 ? "#8a00e2" : "#ffffff";
}

function parseDxScore(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function sumNumericValues(values: unknown[]) {
  let total = 0;
  let found = false;
  for (const value of values) {
    const n = toFiniteNumber(value);
    if (n !== null) {
      total += n;
      found = true;
    }
  }
  return found ? total : null;
}

function getNotesTotal(notes: unknown): number | null {
  if (Array.isArray(notes)) {
    return sumNumericValues(notes);
  }
  if (!notes || typeof notes !== "object") {
    return null;
  }

  const record = notes as Record<string, unknown>;
  const total = toFiniteNumber(record.total);
  if (total !== null) {
    return total;
  }
  if (record.notes !== undefined) {
    const nested = getNotesTotal(record.notes);
    if (nested !== null) {
      return nested;
    }
  }

  return sumNumericValues([
    record.tap,
    record.hold,
    record.slide,
    record.touch,
    record.break,
  ]);
}

function getDxScoreMax(chart: MusicChartPayload | undefined) {
  const total = getNotesTotal(chart?.notes);
  return total !== null ? total * 3 : null;
}

function getDxStar(dxPercent: number) {
  if (dxPercent <= 85) return 0;
  if (dxPercent <= 90) return 1;
  if (dxPercent <= 93) return 2;
  if (dxPercent <= 95) return 3;
  if (dxPercent <= 97) return 4;
  return 5;
}

function buildCards(
  scores: SyncScore[],
  isNew: boolean,
  musicMap: Map<string, MusicRow>,
  chartMap: Map<number, ChartLookup>,
): ExportCard[] {
  return scores.map((score, idx) => {
    const music = musicMap.get(score.musicId);
    const chart = score.cid != null ? chartMap.get(score.cid) : undefined;
    const detailLevelText =
      typeof chart?.detailLevel === "number"
        ? chart.detailLevel.toFixed(1)
        : (chart?.detailLevel ?? chart?.level ?? "?");
    const dxScore = parseDxScore(score.dxScore);
    const dxScoreMax = getDxScoreMax(chart);

    return {
      score,
      ranking: idx + 1,
      isNew,
      musicId: score.musicId,
      chartIndex: score.chartIndex,
      type: score.type,
      scoreText: score.score ?? null,
      dxScoreText:
        score.dxScore && dxScoreMax
          ? `${score.dxScore}/${dxScoreMax}`
          : (score.dxScore ?? null),
      dxStar:
        dxScore !== null && dxScoreMax !== null && dxScoreMax > 0
          ? getDxStar((dxScore / dxScoreMax) * 100)
          : null,
      rating: score.rating ?? null,
      fc: score.fc ?? null,
      fs: score.fs ?? null,
      title: music?.title ?? "Unknown Title",
      detailLevelText: String(detailLevelText),
    };
  });
}

function HideOnErrorImage({
  className,
  src,
  alt,
  style,
}: {
  className?: string;
  src: string;
  alt: string;
  style?: CSSProperties;
}) {
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      style={style}
      referrerPolicy="no-referrer"
      onError={(event) => {
        event.currentTarget.style.display = "none";
      }}
    />
  );
}

function ExportScoreCard({
  card,
  onClick,
  interactive = true,
}: {
  card: ExportCard;
  onClick?: () => void;
  interactive?: boolean;
}) {
  const chartIndex = card.chartIndex;
  const textColor = getCardTextColor(chartIndex);
  const rank = getRankFromScore(card.scoreText);
  const rankAsset = rank ? RANK_ASSET[rank] : null;
  const fcAsset = card.fc ? FC_ASSET[card.fc] : null;
  const fsAsset = card.fs ? FS_ASSET[card.fs] : null;
  const typeAsset = card.type === "dx" ? "DX.png" : "SD.png";
  const ratingText =
    typeof card.rating === "number" ? Math.round(card.rating) : "-";

  const content = (
    <>
      <img
        className={classes.cardBg}
        src={asset(DIFF_CARD_ASSETS[chartIndex] ?? DIFF_CARD_ASSETS[0])}
        alt=""
      />
      <div className={classes.coverFallback}>No Cover</div>
      <HideOnErrorImage
        className={classes.cover}
        src={getCoverUrl(card.musicId)}
        alt={card.title}
      />
      <div
        className={`${classes.cardText} ${classes.cardTitle}`}
        style={{ color: textColor }}
        title={card.title}
      >
        {card.title}
      </div>
      <div
        className={`${classes.cardText} ${classes.scoreText}`}
        style={{ color: textColor }}
      >
        {card.scoreText ?? "N/A"}
      </div>
      <div
        className={`${classes.cardText} ${classes.detailText}`}
        style={{ color: textColor }}
      >
        {card.detailLevelText} {"\u2192"} {ratingText}
      </div>
      {card.dxScoreText ? (
        <div className={classes.dxScoreText} style={{ color: textColor }}>
          {card.dxScoreText}
        </div>
      ) : null}
      <img className={classes.typeBadge} src={asset(typeAsset)} alt="" />
      {rankAsset ? (
        <img className={classes.rankBadge} src={asset(rankAsset)} alt="" />
      ) : rank ? (
        <div className={`${classes.fallbackBadge} ${classes.rankFallback}`}>
          {rank}
        </div>
      ) : null}
      {fcAsset ? (
        <img className={classes.fcBadge} src={asset(fcAsset)} alt="" />
      ) : card.fc ? (
        <div className={`${classes.fallbackBadge} ${classes.fcFallback}`}>
          {card.fc.toUpperCase()}
        </div>
      ) : null}
      {fsAsset ? (
        <img className={classes.fsBadge} src={asset(fsAsset)} alt="" />
      ) : card.fs ? (
        <div className={`${classes.fallbackBadge} ${classes.fsFallback}`}>
          {card.fs.toUpperCase()}
        </div>
      ) : null}
      {card.dxStar && card.dxStar > 0 ? (
        <img
          className={classes.dxStarIcon}
          src={asset(`UI_GAM_Gauge_DXScoreIcon_0${card.dxStar}.png`)}
          alt=""
        />
      ) : null}
      <div
        className={classes.musicId}
        style={{ color: ID_COLORS[chartIndex] ?? textColor }}
      >
        {card.musicId}
      </div>
    </>
  );

  if (!interactive) {
    return (
      <div className={classes.card} aria-label={card.title}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={classes.card}
      onClick={onClick}
      aria-label={card.title}
    >
      {content}
    </button>
  );
}

function CardGrid({
  cards,
  onScoreClick,
}: {
  cards: ExportCard[];
  onScoreClick: Props["onScoreClick"];
}) {
  return (
    <div className={classes.cardGrid}>
      {cards.map((card) => (
        <ExportScoreCard
          key={`${card.isNew ? "new" : "old"}-${card.musicId}-${card.type}-${card.chartIndex}`}
          card={card}
          onClick={() => onScoreClick(card.score, card.ranking, card.isNew)}
        />
      ))}
    </div>
  );
}

export function Best50ExportStyleCardPreview({
  score,
  musicMap,
  chartMap,
}: Best50ExportStyleCardPreviewProps) {
  const card = buildCards(
    [score],
    score.isNew === true,
    musicMap,
    chartMap,
  )[0];
  if (!card) return null;

  return (
    <div className={classes.singleCardPreview}>
      <ExportScoreCard card={card} interactive={false} />
    </div>
  );
}

export function Best50ExportStyleView({
  ratingSummary,
  musicMap,
  chartMap,
  onScoreClick,
}: Props) {
  const newCards = useMemo(
    () => buildCards(ratingSummary.newTop, true, musicMap, chartMap),
    [chartMap, musicMap, ratingSummary.newTop],
  );
  const oldCards = useMemo(
    () => buildCards(ratingSummary.oldTop, false, musicMap, chartMap),
    [chartMap, musicMap, ratingSummary.oldTop],
  );

  return (
    <div className={classes.view}>
      <section className={classes.section}>
        <div className={classes.sectionHeader}>
          <div className={classes.sectionTitle}>现版本 Best 15</div>
          <div className={classes.sectionRating}>
            Rating: {ratingSummary.newSum.toFixed(0)}
          </div>
        </div>
        <CardGrid cards={newCards} onScoreClick={onScoreClick} />
      </section>

      <section className={classes.section}>
        <div className={classes.sectionHeader}>
          <div className={classes.sectionTitle}>旧版本 Best 35</div>
          <div className={classes.sectionRating}>
            Rating: {ratingSummary.oldSum.toFixed(0)}
          </div>
        </div>
        <CardGrid cards={oldCards} onScoreClick={onScoreClick} />
      </section>
    </div>
  );
}
