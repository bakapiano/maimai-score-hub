// Utility functions for Music Score Card components

import { apiUrl } from "../../api/baseUrl";

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

const STATUS_ASSET: Record<string, string> = {
  fc: "UI_MSS_MBase_Icon_FC.png",
  "fc+": "UI_MSS_MBase_Icon_FCp.png",
  fcp: "UI_MSS_MBase_Icon_FCp.png",
  ap: "UI_MSS_MBase_Icon_AP.png",
  "ap+": "UI_MSS_MBase_Icon_APp.png",
  app: "UI_MSS_MBase_Icon_APp.png",
  fs: "UI_MSS_MBase_Icon_FS.png",
  "fs+": "UI_MSS_MBase_Icon_FSp.png",
  fsp: "UI_MSS_MBase_Icon_FSp.png",
  fdx: "UI_MSS_MBase_Icon_FSD.png",
  "fdx+": "UI_MSS_MBase_Icon_FSDp.png",
  fdxp: "UI_MSS_MBase_Icon_FSDp.png",
  fsd: "UI_MSS_MBase_Icon_FSD.png",
  "fsd+": "UI_MSS_MBase_Icon_FSDp.png",
  fsdp: "UI_MSS_MBase_Icon_FSDp.png",
};

export function getRank(scoreVal: number): string {
  if (scoreVal >= 100.5) {return "SSS+";}
  if (scoreVal >= 100) {return "SSS";}
  if (scoreVal >= 99.5) {return "SS+";}
  if (scoreVal >= 99) {return "SS";}
  if (scoreVal >= 98) {return "S+";}
  if (scoreVal >= 97) {return "S";}
  if (scoreVal >= 94) {return "AAA";}
  if (scoreVal >= 90) {return "AA";}
  if (scoreVal >= 80) {return "A";}
  return "F";
}

export function renderRank(
  r: string,
  opts?: { compact?: boolean; stroke?: boolean; width?: number },
) {
  const isCompact = opts?.compact === true;
  const asset = RANK_ASSET[r];

  if (asset) {
    const width = opts?.width ?? (isCompact ? 42 : 72);
    const imageStyle = {
      display: "inline-block",
      width,
      maxHeight: isCompact ? 24 : 32,
      height: "auto",
      verticalAlign: "middle",
    } as const;

    if (opts?.stroke) {
      return (
        <svg
          viewBox="0 0 256 120"
          role="img"
          aria-label={r}
          style={imageStyle}
        >
          <defs>
            <filter id="rank-outline" x="-10%" y="-20%" width="120%" height="140%">
              <feMorphology
                in="SourceAlpha"
                operator="dilate"
                radius="7"
                result="expanded"
              />
              <feFlood floodColor="#111" result="outlineColor" />
              <feComposite
                in="outlineColor"
                in2="expanded"
                operator="in"
                result="outline"
              />
              <feMerge>
                <feMergeNode in="outline" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <image
            href={`/mai/pic/${asset}`}
            width="256"
            height="120"
            filter="url(#rank-outline)"
          />
        </svg>
      );
    }

    return (
      <img
        src={`/mai/pic/${asset}`}
        alt={r}
        style={imageStyle}
      />
    );
  }

  return (
    <span
      style={{
        display: r === "N/A" ? "inline-block" : undefined,
        width:
          r === "N/A" ? opts?.width ?? (isCompact ? 42 : 72) : undefined,
        visibility: r === "N/A" ? "hidden" : undefined,
        letterSpacing: isCompact ? 0 : 1,
      }}
    >
      {r}
    </span>
  );
}

export function renderMusicIcon(
  icon: string,
  opts?: { compact?: boolean; alt?: string },
) {
  const normalized = icon.toLowerCase();
  const asset = STATUS_ASSET[normalized];
  const alt = opts?.alt ?? icon.toUpperCase();

  if (asset) {
    return (
      <img
        src={`/mai/pic/${asset}`}
        alt={alt}
        style={{
          display: "inline-block",
          width: opts?.compact ? 28 : 38,
          maxHeight: opts?.compact ? 24 : 32,
          height: "auto",
          verticalAlign: "middle",
        }}
      />
    );
  }

  return alt;
}

export function renderScoreStatusIcon(
  icon: string,
  opts?: { size?: number; stroke?: boolean },
) {
  const size = opts?.size ?? 24;
  const src = getIconUrl(icon);

  if (opts?.stroke) {
    return (
      <svg
        viewBox="0 0 42 47"
        role="img"
        aria-label={icon.toUpperCase()}
        width={size}
        height={size}
        style={{ display: "block" }}
      >
        <defs>
          <filter
            id="status-icon-outline"
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
          >
            <feMorphology
              in="SourceAlpha"
              operator="dilate"
              radius="2"
              result="expanded"
            />
            <feFlood floodColor="#111" result="outlineColor" />
            <feComposite
              in="outlineColor"
              in2="expanded"
              operator="in"
              result="outline"
            />
            <feMerge>
              <feMergeNode in="outline" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <image
          href={src}
          width="42"
          height="47"
          filter="url(#status-icon-outline)"
        />
      </svg>
    );
  }

  return (
    <img
      src={src}
      alt={icon.toUpperCase()}
      width={size}
      height={size}
      style={{ display: "block" }}
    />
  );
}

/**
 * Parse score string to number
 */
export function parseScore(score: string | null): number | null {
  if (typeof score !== "string" || score.trim().length === 0) {return null;}
  const parsed = parseFloat(score.replace("%", ""));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Get rank from score string
 */
export function getRankFromScore(score: string | null): string {
  const parsed = parseScore(score);
  return parsed !== null ? getRank(parsed) : "N/A";
}

/**
 * Build cover URL from music ID
 * v=3: bust browser cache after enabling webp content-negotiation
 */
export function getCoverUrl(musicId: string): string {
  return apiUrl(`/catalog/covers/${musicId}?v=3`);
}

/**
 * Get FC/FS icon URL
 */
export function getIconUrl(icon: string): string {
  return `/maimai-mobile/img/music_icon_${normalizeRemoteIconKey(icon)}.png`;
}

function normalizeRemoteIconKey(icon: string): string {
  switch (icon.toLowerCase()) {
    case "fc+":
      return "fcp";
    case "ap+":
      return "app";
    case "fs+":
      return "fsp";
    case "fdx+":
    case "fdxp":
    case "fsd+":
    case "fsdp":
      return "fdxp";
    case "fsd":
      return "fdx";
    default:
      return icon.toLowerCase();
  }
}
