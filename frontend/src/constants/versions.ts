// Version order for sorting (oldest first)
export const VERSION_ORDER: string[] = [
  "舞萌DX 2026",
  "舞萌DX 2025",
  "舞萌DX 2024",
  "舞萌DX 2023",
  "舞萌DX 2022",
  "舞萌DX 2021",
  "舞萌DX",
  "finale",
  "milk+",
  "milk",
  "murasaki+",
  "murasaki",
  "pink+",
  "pink",
  "orange+",
  "orange",
  "green+",
  "green",
  "maimai+",
  "maimai",
];

/** Version key → plate-style display name */
export const VERSION_DISPLAY_NAME: Record<string, string> = {
  maimai: "maimai (真代)",
  "maimai+": "maimai+ (真代)",
  green: "green (超代)",
  "green+": "green+ (檄代)",
  orange: "orange (橙代)",
  "orange+": "orange+ (暁代)",
  pink: "pink (桃代)",
  "pink+": "pink+ (櫻代)",
  murasaki: "murasaki (紫代)",
  "murasaki+": "murasaki+ (菫代)",
  milk: "milk (白代)",
  "milk+": "milk+ (雪代)",
  finale: "finale (輝代)",
  舞萌DX: "舞萌DX (熊華代)",
  "舞萌DX 2021": "舞萌DX 2021 (爽煌代)",
  "舞萌DX 2022": "舞萌DX 2022 (宙星代)",
  "舞萌DX 2023": "舞萌DX 2023 (祭祝代)",
  "舞萌DX 2024": "舞萌DX 2024 (双宴代)",
  "舞萌DX 2025": "舞萌DX 2025 (镜彩代)",
  "舞萌DX 2026": "舞萌DX 2026",
};

/**
 * "舞代" = all old versions (maimai → FiNALE), used for 霸/舞 plate
 */
export const MAI_LEGACY_VERSIONS = [
  "maimai",
  "maimai+",
  "green",
  "green+",
  "orange",
  "orange+",
  "pink",
  "pink+",
  "murasaki",
  "murasaki+",
  "milk",
  "milk+",
  "finale",
];

export function getVersionDisplayName(version: string): string {
  return VERSION_DISPLAY_NAME[version] ?? version;
}

export const getVersionSortIndex = (version: string): number => {
  const index = VERSION_ORDER.indexOf(version);
  return index === -1 ? VERSION_ORDER.length : index;
};

export const sortVersions = (versions: string[]): string[] => {
  return [...versions].sort(
    (a, b) => getVersionSortIndex(a) - getVersionSortIndex(b),
  );
};
