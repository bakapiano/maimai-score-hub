import { Box, Card, Group, Image, Text } from "@mantine/core";
import {
  GOLD_SCORE_STROKE_STYLE,
  LEVEL_COLORS,
  MINIMAL_COVER_SIZE,
} from "./constants";
import {
  getCoverUrl,
  getIconUrl,
  getRankFromScore,
  parseScore,
  renderRank,
} from "./utils";

import type { MusicScoreCardProps } from "./types";
import type { DisplayFilterSettings } from "../ScoreDisplayFilter.model";
import { DeferredImage } from "../DeferredImage";

type MinimalMusicScoreCardProps = Pick<
  MusicScoreCardProps,
  "musicId" | "chartIndex" | "type" | "score" | "fs" | "fc"
> & {
  displaySettings?: DisplayFilterSettings;
};

type MinimalScoreOverlayProps = {
  fc: string | null;
  fs: string | null;
  rank: string;
  scoreText: string | null;
  showFc: boolean;
  showFs: boolean;
  showScore: boolean;
  scoreDisplayMode: DisplayFilterSettings["scoreDisplayMode"];
};

function formatMinimalScore(score: string | null, decimals: number) {
  const scoreNumeric = parseScore(score);
  if (scoreNumeric === null) {
    return null;
  }
  const factor = Math.pow(10, decimals);
  const truncated = Math.floor(scoreNumeric * factor) / factor;
  return `${truncated.toFixed(decimals)}%`;
}

function EmptyStatusDot() {
  return (
    <Box
      w={20}
      h={20}
      style={{
        borderRadius: "50%",
        backgroundColor: "white",
        border: "1px solid #ccc",
      }}
    />
  );
}

function MinimalStatusIcon({ icon }: { icon: string | null }) {
  return (
    <Box
      w={24}
      h={24}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {icon ? (
        <Image src={getIconUrl(icon)} w={24} referrerPolicy="no-referrer" />
      ) : (
        <EmptyStatusDot />
      )}
    </Box>
  );
}

function MinimalScoreOverlay({
  fc,
  fs,
  rank,
  scoreText,
  showFc,
  showFs,
  showScore,
  scoreDisplayMode,
}: MinimalScoreOverlayProps) {
  const hasIcons = showFc || showFs;

  return (
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
        <Box
          h={26}
          px={4}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            background: "rgba(16, 20, 28, 0.68)",
            boxShadow: "0 1px 4px rgba(0,0,0,0.45)",
            backdropFilter: "blur(1px)",
            WebkitBackdropFilter: "blur(1px)",
          }}
        >
          {renderRank(rank, { compact: true, width: 48 })}
        </Box>
      )}
      {showScore && scoreDisplayMode === "score" && (
        <Text
          fw={900}
          size="xs"
          px={4}
          style={{
            borderRadius: 6,
            background: "rgba(16, 20, 28, 0.68)",
            boxShadow: "0 1px 4px rgba(0,0,0,0.45)",
            ...GOLD_SCORE_STROKE_STYLE,
          }}
        >
          {scoreText ?? "N/A"}
        </Text>
      )}
      {hasIcons && (
        <Group gap={0} align="center" justify="center">
          {showFc && <MinimalStatusIcon icon={fc} />}
          {showFs && <MinimalStatusIcon icon={fs} />}
        </Group>
      )}
    </Box>
  );
}

export function MinimalMusicScoreCard({
  musicId,
  chartIndex,
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
  const scoreText = formatMinimalScore(score, scoreDecimals);

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
        }}
      >
        <Box style={{ position: "relative" }}>
          <DeferredImage
            src={coverUrl}
            w={MINIMAL_COVER_SIZE}
            h={MINIMAL_COVER_SIZE}
            radius="sm"
            style={{
              display: "block",
            }}
          />

          <MinimalScoreOverlay
            fc={fc}
            fs={fs}
            rank={rank}
            scoreText={scoreText}
            showFc={showFc}
            showFs={showFs}
            showScore={showScore}
            scoreDisplayMode={scoreDisplayMode}
          />
        </Box>
      </Box>
    </Card>
  );
}
