// Version order for sorting (oldest first)
export const VERSION_ORDER: string[] = [
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
  "舞萌DX",
  "舞萌DX 2021",
  "舞萌DX 2022",
  "舞萌DX 2023",
  "舞萌DX 2024",
  "舞萌DX 2025",
];

export const getVersionSortIndex = (version: string): number => {
  const index = VERSION_ORDER.indexOf(version);
  // Unknown versions go to the end
  return index === -1 ? VERSION_ORDER.length : index;
};

export const sortVersions = (versions: string[]): string[] => {
  return [...versions].sort(
    (a, b) => getVersionSortIndex(a) - getVersionSortIndex(b)
  );
};
