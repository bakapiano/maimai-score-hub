import {
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  CompactMusicScoreCard,
  type DetailedMusicScoreCardProps,
} from "../../components/MusicScoreCard";

import { IconTrophy, IconDownload } from "@tabler/icons-react";
import { ScoreDetailModal } from "../../components/ScoreDetailModal";
import type { SyncScore } from "../../types/syncScore";
import { useMemo, useState } from "react";
import { useMusic } from "../../providers/MusicProvider";
import { useAuth } from "../../providers/AuthProvider";

type RatingSummary = {
  newTop: SyncScore[];
  oldTop: SyncScore[];
  newSum: number;
  oldSum: number;
  totalSum: number;
  newMax: number | null;
  newMin: number | null;
  oldMax: number | null;
  oldMin: number | null;
};

const buildRatingSummary = (scores: SyncScore[]): RatingSummary | null => {
  if (!Array.isArray(scores)) return null;

  const withRating = scores.filter((s) => typeof s.rating === "number");

  const newScores = withRating
    .filter((s) => s.isNew === true)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const oldScores = withRating
    .filter((s) => s.isNew === false)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));

  const newTop = newScores.slice(0, 15);
  const oldTop = oldScores.slice(0, 35);

  const newSum = newTop.reduce((sum, s) => sum + (s.rating ?? 0), 0);
  const oldSum = oldTop.reduce((sum, s) => sum + (s.rating ?? 0), 0);

  const newMax = newTop.length > 0 ? (newTop[0].rating ?? null) : null;
  const newMin =
    newTop.length > 0 ? (newTop[newTop.length - 1].rating ?? null) : null;
  const oldMax = oldTop.length > 0 ? (oldTop[0].rating ?? null) : null;
  const oldMin =
    oldTop.length > 0 ? (oldTop[oldTop.length - 1].rating ?? null) : null;

  return {
    newTop,
    oldTop,
    newSum,
    oldSum,
    totalSum: newSum + oldSum,
    newMax,
    newMin,
    oldMax,
    oldMin,
  };
};

type Best50TabProps = {
  scores: SyncScore[];
  loading: boolean;
};

export function Best50Tab({ scores, loading }: Best50TabProps) {
  const { musicMap, chartMap } = useMusic();
  const { token } = useAuth();
  const ratingSummary = useMemo(() => buildRatingSummary(scores), [scores]);

  // Modal state
  const [modalOpened, setModalOpened] = useState(false);
  const [selectedScore, setSelectedScore] =
    useState<DetailedMusicScoreCardProps | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleScoreClick = (
    score: SyncScore,
    ranking: number,
    isNew: boolean,
  ) => {
    const music = musicMap.get(score.musicId);
    const chart = score.cid != null ? chartMap.get(score.cid) : undefined;
    setSelectedScore({
      musicId: score.musicId,
      chartIndex: score.chartIndex,
      type: score.type,
      rating: score.rating ?? null,
      score: score.score || null,
      fs: score.fs || null,
      fc: score.fc || null,
      dxScore: score.dxScore || null,
      chartPayload: chart || null,
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
          : parseInt(music?.bpm as string) || null,
      noteDesigner: chart?.charter || null,
      ranking,
      isNew,
    });
    setModalOpened(true);
  };

  const handleExport = async () => {
    if (!token) return;
    setExporting(true);
    try {
      const res = await fetch("/api/score-export/best50", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`导出失败 (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "best50.png";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert((err as Error).message || "导出失败");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Stack gap="md">
      <ScoreDetailModal
        opened={modalOpened}
        onClose={() => setModalOpened(false)}
        scoreData={selectedScore}
      />
      <Group justify="space-between" align="center">
        <Title size="h3" order={4}>
          Best 50
        </Title>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconDownload size={14} />}
          onClick={handleExport}
          loading={exporting}
        >
          导出图片
        </Button>
      </Group>
      <Card withBorder shadow="none" padding="lg" radius="md">
        {ratingSummary ? (
          <Group justify="space-between" align="center" wrap="wrap">
            <Stack gap={4}>
              <Group gap={6} align="center">
                <IconTrophy size={14} color="var(--mantine-color-dimmed)" />
                <Text size="xs" tt="uppercase" fw={600} c="dimmed">
                  Rating
                </Text>
              </Group>
              <Text
                size="xl"
                fw={700}
                variant="gradient"
                gradient={{ from: "blue", to: "grape", deg: 90 }}
              >
                {ratingSummary.totalSum.toFixed(0)}
              </Text>
            </Stack>

            <Group gap="xl">
              <Stack gap={4} align="center">
                <Text size="xs" c="dimmed" fw={500}>
                  B35
                </Text>
                <Badge size="lg" variant="light" radius="sm">
                  {ratingSummary.oldSum.toFixed(0)}
                </Badge>
                <Group gap={4}>
                  <Text size="xs" c="dimmed">
                    {ratingSummary.oldMax?.toFixed(0) ?? "-"} ~{" "}
                    {ratingSummary.oldMin?.toFixed(0) ?? "-"}
                  </Text>
                </Group>
              </Stack>
              <Stack gap={4} align="center">
                <Text size="xs" c="dimmed" fw={500}>
                  B15
                </Text>
                <Badge size="lg" color="teal" variant="light" radius="sm">
                  {ratingSummary.newSum.toFixed(0)}
                </Badge>
                <Group gap={4}>
                  <Text size="xs" c="dimmed">
                    {ratingSummary.newMax?.toFixed(0) ?? "-"} ~{" "}
                    {ratingSummary.newMin?.toFixed(0) ?? "-"}
                  </Text>
                </Group>
              </Stack>
            </Group>
          </Group>
        ) : (
          <Group justify="center" py="xs">
            <Text c="dimmed" size="sm">
              {loading ? "加载中..." : "暂无 rating 数据"}
            </Text>
          </Group>
        )}
      </Card>

      {ratingSummary ? (
        <Stack gap="lg">
          <Stack gap={8}>
            <Title size="h3" order={5}>
              现版本 Best 15
            </Title>
            <Group
              gap="sm"
              align="stretch"
              wrap="wrap"
              style={{ width: "100%" }}
            >
              {ratingSummary.newTop.slice(0, 15).map((score, idx) => {
                const music = musicMap.get(score.musicId);
                const chart =
                  score.cid != null ? chartMap.get(score.cid) : undefined;
                return (
                  <div
                    key={`new-${score.musicId}-${score.type}-${score.chartIndex}`}
                    style={{ cursor: "pointer" }}
                    onClick={() => handleScoreClick(score, idx + 1, true)}
                  >
                    <CompactMusicScoreCard
                      musicId={score.musicId}
                      chartIndex={score.chartIndex}
                      type={score.type}
                      rating={score.rating ?? null}
                      score={score.score || null}
                      fs={score.fs || null}
                      fc={score.fc || null}
                      chartPayload={chart || null}
                      songMetadata={music || null}
                      bpm={
                        typeof music?.bpm === "number"
                          ? music.bpm
                          : parseInt(music?.bpm as string) || null
                      }
                      noteDesigner={chart?.charter || null}
                    />
                  </div>
                );
              })}
              {ratingSummary.newTop.length === 0 && (
                <Text c="dimmed">暂无新曲</Text>
              )}
            </Group>
          </Stack>

          <Stack gap={8}>
            <Divider />
            <Title size={"h3"} order={5}>
              旧版本 Best 35
            </Title>
            <Group
              gap="sm"
              align="stretch"
              wrap="wrap"
              style={{ width: "100%" }}
            >
              {ratingSummary.oldTop.slice(0, 35).map((score, idx) => {
                const music = musicMap.get(score.musicId);
                const chart =
                  score.cid != null ? chartMap.get(score.cid) : undefined;
                return (
                  <div
                    key={`old-${score.musicId}-${score.type}-${score.chartIndex}`}
                    style={{ cursor: "pointer" }}
                    onClick={() => handleScoreClick(score, idx + 1, false)}
                  >
                    <CompactMusicScoreCard
                      musicId={score.musicId}
                      chartIndex={score.chartIndex}
                      type={score.type}
                      rating={score.rating ?? null}
                      score={score.score || null}
                      fs={score.fs || null}
                      fc={score.fc || null}
                      chartPayload={chart || null}
                      songMetadata={music || null}
                      bpm={
                        typeof music?.bpm === "number"
                          ? music.bpm
                          : parseInt(music?.bpm as string) || null
                      }
                      noteDesigner={chart?.charter || null}
                    />
                  </div>
                );
              })}
              {ratingSummary.oldTop.length === 0 && (
                <Text c="dimmed">暂无旧曲</Text>
              )}
            </Group>
          </Stack>
        </Stack>
      ) : (
        !loading && <Text c="dimmed">暂无 B50 数据</Text>
      )}
    </Stack>
  );
}
