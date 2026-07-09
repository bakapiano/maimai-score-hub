export const LEVEL_COLORS = [
  '#6fe163',
  '#f8df3a',
  '#fc4255',
  '#9a15ff',
  '#dc9fff',
];

/** Song ID colors per difficulty – original maimaiDX id_color. */
export const ID_COLORS = [
  '#81d955', // Basic
  '#f5bd15', // Advanced
  '#ff818d', // Expert
  '#9f51dc', // Master
  '#8a00e2', // Re:Master
];

export const DIFFICULTY_NAMES = [
  'Basic',
  'Advanced',
  'Expert',
  'Master',
  'Re:Master',
];

export const FC_NAMES: Record<string, string> = {
  fc: 'FC',
  'fc+': 'FC+',
  fcp: 'FC+',
  ap: 'AP',
  'ap+': 'AP+',
  app: 'AP+',
};

export const FS_NAMES: Record<string, string> = {
  fs: 'FS',
  'fs+': 'FS+',
  fsp: 'FS+',
  fdx: 'FDX',
  'fdx+': 'FDX+',
  fdxp: 'FDX+',
  fsd: 'FDX',
  'fsd+': 'FDX+',
  fsdp: 'FDX+',
};

export const VERSION_ORDER: string[] = [
  'maimai',
  'maimai+',
  'green',
  'green+',
  'orange',
  'orange+',
  'pink',
  'pink+',
  'murasaki',
  'murasaki+',
  'milk',
  'milk+',
  'finale',
  '舞萌DX',
  '舞萌DX 2021',
  '舞萌DX 2022',
  '舞萌DX 2023',
  '舞萌DX 2024',
  '舞萌DX 2025',
  '舞萌DX 2026',
];

/** Version key → plate-style display name (used in exported images) */
export const VERSION_DISPLAY_NAME: Record<string, string> = {
  maimai: '真代',
  'maimai+': '真代',
  green: '超代',
  'green+': '檄代',
  orange: '橙代',
  'orange+': '暁代',
  pink: '桃代',
  'pink+': '櫻代',
  murasaki: '紫代',
  'murasaki+': '菫代',
  milk: '白代',
  'milk+': '雪代',
  finale: '輝代',
  舞萌DX: '熊華代',
  '舞萌DX 2021': '爽煌代',
  '舞萌DX 2022': '宙星代',
  '舞萌DX 2023': '祭祝代',
  '舞萌DX 2024': '双宴代',
  '舞萌DX 2025': '镜彩代',
  '舞萌DX 2026': '舞萌DX 2026',
  __mai__: '舞代',
};

export const FONT_FAMILY =
  '"Resource Han Rounded CN", "Torus", "PingFang SC", "Noto Sans CJK SC", sans-serif';
