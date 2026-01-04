import type { ConfigService } from '@nestjs/config';

const DEFAULT_SOURCE_URL =
  'https://www.diving-fish.com/api/maimaidxprober/music_data';
const CATEGORY_MAP: Record<string, string> = {
  'niconico & VOCALOID': 'niconico＆VOCALOID™',
  '音击&中二节奏': '音击/中二节奏',
};

export function mapDivingFishCategory(raw: unknown): string | null | undefined {
  if (typeof raw !== 'string') return raw as string | null | undefined;
  return CATEGORY_MAP[raw] ?? raw;
}

export function mapDivingFishType(
  rawType: string | undefined,
  mappedCategory?: string | null,
): 'standard' | 'dx' | 'utage' | string | undefined {
  if (mappedCategory === '宴会場') return 'utage';
  if (rawType === 'SD') return 'standard';
  if (rawType === 'DX') return 'dx';
  return rawType;
}

export function getDivingFishMusicSourceUrl(
  configService: ConfigService,
): string {
  return configService.get<string>('MUSIC_DATA_URL', DEFAULT_SOURCE_URL);
}