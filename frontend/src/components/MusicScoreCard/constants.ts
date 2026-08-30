// Constants for Music Score Card components

export const LEVEL_COLORS: Record<number, string> = {
  0: "#6fe163", // Basic
  1: "#f8df3a", // Advanced
  2: "#fc4255ff", // Expert
  3: "#9a15ffff", // Master
  4: "#dc9fffff", // Re:Master
  10: "#ff69b4", // Utage
};

export const DIFFICULTY_NAMES: Record<number, string> = {
  0: "Basic",
  1: "Advanced",
  2: "Expert",
  3: "Master",
  4: "Re:Master",
  10: "Utage",
};

export const WHITE_TEXT_STROKE =
  "-1px 0 0 black, 0 1px 0 black, 1px 0 0 black, 0 -1px 0 black, -1px -1px 0 black, 1px -1px 0 black, -1px 1px 0 black, 1px 1px 0 black";

export const GLASS_TEXT_SHADOW = "0 2px 6px rgba(0,0,0,0.55)";

/** Prefer CSS `-webkit-text-stroke` + `paint-order: stroke fill` over this. */
export const TEXT_STROKE_GOLD_BLACK =
  "0 0 2px #f5d142, -1px 0 0 #000, 1px 0 0 #000, 0 -1px 0 #000, 0 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000";

export const GOLD_SCORE_STROKE_STYLE = {
  color: "#f5d142",
  WebkitTextStroke: "2.25px #000",
  paintOrder: "stroke fill",
  textShadow: "0 1px 1.5px rgba(0,0,0,0.3)",
} as const;

// Cover sizes
export const COVER_SIZE = 200;
export const COMPACT_COVER_SIZE = 140;
export const MINIMAL_COVER_SIZE = 75;
export const DETAILED_COVER_SIZE = 280;

// FC/FS display name mapping
export const FC_NAMES: Record<string, string> = {
  fc: "FC",
  "fc+": "FC+",
  fcp: "FC+",
  ap: "AP",
  "ap+": "AP+",
  app: "AP+",
};

export const FS_NAMES: Record<string, string> = {
  fs: "FS",
  "fs+": "FS+",
  fsp: "FS+",
  fdx: "FDX",
  "fdx+": "FDX+",
  fdxp: "FDX+",
  fsd: "FDX",
  "fsd+": "FDX+",
  fsdp: "FDX+",
};
