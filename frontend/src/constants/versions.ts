// Version order for sorting (oldest first)
export const VERSION_ORDER: string[] = [
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
