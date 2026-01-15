// Constants for Music Score Card components

export const LEVEL_COLORS = [
  "#6fe163", // Basic
  "#f8df3a", // Advanced
  "#fc4255ff", // Expert
  "#9a15ffff", // Master
  "#dc9fffff", // Re:Master
];

export const DIFFICULTY_NAMES = [
  "Basic",
  "Advanced",
  "Expert",
  "Master",
  "Re:Master",
];

export const WHITE_TEXT_STROKE =
  "-1px 0 black, 0 1px black, 1px 0 black, 0 -1px black";

export const GLASS_TEXT_SHADOW = "0 2px 6px rgba(0,0,0,0.55)";

// Gold glow plus tight black outline (gold stays visible, outline stays crisp)
export const TEXT_STROKE_GOLD_BLACK =
  "0 0 0 #f5d142, 0 0 2px #f5d142, -1px -1px #000, 1px -1px #000, -1px 1px #000, 1px 1px #000";

export const STROKE_STYLE = {} as const;

// Cover sizes
export const COVER_SIZE = 200;
export const COMPACT_COVER_SIZE = 160;
export const MINIMAL_COVER_SIZE = 60;
export const DETAILED_COVER_SIZE = 280;

// FC/FS display name mapping
export const FC_NAMES: Record<string, string> = {
  fc: "FC",
  fcp: "FC+",
  ap: "AP",
  app: "AP+",
};

export const FS_NAMES: Record<string, string> = {
  fs: "FS",
  fsp: "FS+",
  fsd: "FSD",
  fsdp: "FSD+",
};
