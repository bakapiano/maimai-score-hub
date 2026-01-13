import { Badge, Box, Card, Group, Image, Stack, Text } from "@mantine/core";

// Types based on the user request and context
export interface ChartPayload {
  level?: string;
  detailLevel?: number | null;
  charter?: string | null;
}

export interface SongMetadata {
  title?: string;
  artist?: string | null;
  category?: string | null;
  isNew?: boolean | null;
}

export interface MusicScoreCardProps {
  musicId: string;
  chartIndex: number;
  type: string;
  rating: number | null;
  score: string | null;
  fs: string | null;
  fc: string | null;
  chartPayload?: ChartPayload | null;
  songMetadata?: SongMetadata | null;
  bpm?: number | null; // BPM
  noteDesigner?: string | null; // Note Designer
}

const LEVEL_COLORS = [
  "#6fe163", // Basic
  "#f8df3a", // Advanced
  "#fc4255ff", // Expert
  "#9a15ffff", // Master
  "#dc9fffff", // Re:Master
];

const DIFFICULTY_NAMES = ["Basic", "Advanced", "Expert", "Master", "Re:Master"];
const WHITE_TEXT_STROKE =
  "-1px 0 black, 0 1px black, 1px 0 black, 0 -1px black";
const GLASS_TEXT_SHADOW = "0 2px 6px rgba(0,0,0,0.55)";
// Gold glow plus tight black outline (gold stays visible, outline stays crisp)
const TEXT_STROKE_GOLD_BLACK =
  "0 0 0 #f5d142, 0 0 2px #f5d142, -1px -1px #000, 1px -1px #000, -1px 1px #000, 1px 1px #000";
const COVER_SIZE = 200; // keep cover size as a single source of truth
const COMPACT_COVER_SIZE = 160;
const MINIMAL_COVER_SIZE = 60;
const STROKE_STYLE = {} as const;

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
  return "F";
}

export function renderRank(
  r: string,
  opts?: { compact?: boolean; stroke?: boolean }
) {
  const isCompact = opts?.compact === true;
  const hasStroke = opts?.stroke === true;
  const textShadow =
    isCompact && !hasStroke
      ? "none"
      : "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000";
  const letterSpacing = isCompact ? (hasStroke ? 1 : 0) : 1;

  if (r === "SSS" || r === "SSS+") {
    const parts = [
      { ch: "S", color: "#f5d142" }, // gold
      { ch: "S", color: "#4ea3ff" }, // blue
      { ch: "S", color: "#ff4d4f" }, // red
    ];
    const extra = r.endsWith("+") ? [{ ch: "+", color: "#f5d142" }] : [];
    return (
      <span style={{ textShadow, letterSpacing }}>
        {parts.concat(extra).map((p, idx) => (
          <span
            key={`${p.ch}-${idx}`}
            style={{ color: p.color, ...STROKE_STYLE }}
          >
            {p.ch}
          </span>
        ))}
      </span>
    );
  }
  if (["S", "S+", "SS", "SS+"].includes(r)) {
    return (
      <span
        style={{
          color: "#f5d142",
          ...STROKE_STYLE,
          textShadow,
          letterSpacing,
        }}
      >
        {r}
      </span>
    ); // gold
  }
  if (["A", "AA", "AAA"].includes(r)) {
    return (
      <span
        style={{
          color: "#ff4d4f",
          ...STROKE_STYLE,
          textShadow,
          letterSpacing,
        }}
      >
        {r}
      </span>
    ); // red
  }
  return (
    <span
      style={{
        ...STROKE_STYLE,
        textShadow,
        letterSpacing,
      }}
    >
      {r}
    </span>
  );
}

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

  const coverUrl = `/api/cover/${musicId}`;

  const hasScore = typeof score === "string" && score.trim().length > 0;
  const safeScore = hasScore ? parseFloat(score.replace("%", "")) : null;
  const rank =
    hasScore && safeScore !== null && !Number.isNaN(safeScore)
      ? getRank(safeScore)
      : "N/A";

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
              <Text
                fw={900}
                c="#f5d142"
                // style={{ textShadow: "0 0 4px #000" }}
              >
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
                  <Image
                    src={`https://maimai.wahlap.com/maimai-mobile/img/music_icon_${fc}.png`}
                    w={32}
                  />
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
                // h={45}
                w={32}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                p={0}
              >
                {fs ? (
                  <Image
                    src={`https://maimai.wahlap.com/maimai-mobile/img/music_icon_${fs}.png`}
                    w={32}
                  />
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

        {/* Footer Info: Note Designer & BPM */}
        {/* <Group
          justify="space-between"
          align="center"
          mt="xs"
          style={{ borderTop: "1px dashed black", paddingTop: 4 }}
        >
          <Stack gap={0}>
            <Text size="xs" fw={700}>
              NOTES DESIGNER
            </Text>
            <Text size="xs" fw={700} lineClamp={1} title={noteDesigner || ""}>
              {noteDesigner || "-"}
            </Text>
          </Stack>
          <Group gap={4} align="center">
            <Text size="xs" fw={700}>
              BPM
            </Text>
            <Text size="xs" fw={700}>
              {bpm || "-"}
            </Text>
          </Group>
        </Group> */}
      </Box>
    </Card>
  );
}

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
  const coverUrl = `/api/cover/${musicId}`;
  const hasScore = typeof score === "string" && score.trim().length > 0;
  const safeScore = hasScore ? parseFloat(score.replace("%", "")) : null;
  const rank =
    hasScore && safeScore !== null && !Number.isNaN(safeScore)
      ? getRank(safeScore)
      : "N/A";

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
                <Image
                  src={`https://maimai.wahlap.com/maimai-mobile/img/music_icon_${fc}.png`}
                  w={24}
                />
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
                <Image
                  src={`https://maimai.wahlap.com/maimai-mobile/img/music_icon_${fs}.png`}
                  w={24}
                  h={24}
                />
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

export function MinimalMusicScoreCard({
  musicId,
  chartIndex,
  type: _type,
  score,
  fs,
  fc,
}: Pick<
  MusicScoreCardProps,
  "musicId" | "chartIndex" | "type" | "score" | "fs" | "fc"
>) {
  const difficultyColor = LEVEL_COLORS[chartIndex] || "#888";
  const coverUrl = `/api/cover/${musicId}`;
  const hasScore = typeof score === "string" && score.trim().length > 0;
  const safeScore = hasScore ? parseFloat(score.replace("%", "")) : null;
  const rank =
    hasScore && safeScore !== null && !Number.isNaN(safeScore)
      ? getRank(safeScore)
      : "N/A";

  return (
    <Card
      withBorder
      padding="0"
      radius="sm"
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
          <Image
            src={coverUrl}
            fallbackSrc="https://placehold.co/200x200?text=No+Cover"
            w={MINIMAL_COVER_SIZE}
            h={MINIMAL_COVER_SIZE}
            radius="sm"
            // loading="lazy"
            style={{
              display: "block",
            }}
          />

          {/* {type === "dx" && (
            <Badge
              size="xs"
              variant="filled"
              radius="999"
              color={"orange"}
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                zIndex: 10,
                pointerEvents: "none",
              }}
              px={2}
            >
              {type?.toUpperCase?.() ?? "-"}
            </Badge>
          )} */}

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
            <Text
              fw={900}
              size="lg"
              c="white"
              style={{ textShadow: TEXT_STROKE_GOLD_BLACK }}
            >
              {renderRank(rank)}
            </Text>
            <Group gap={0} align="center" justify="center">
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
                  <Image
                    src={`https://maimai.wahlap.com/maimai-mobile/img/music_icon_${fc}.png`}
                    w={24}
                  />
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
                  <Image
                    src={`https://maimai.wahlap.com/maimai-mobile/img/music_icon_${fs}.png`}
                    w={24}
                  />
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
            </Group>
          </Box>
        </Box>
      </Box>
    </Card>
  );
}
