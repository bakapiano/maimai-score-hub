import { decodeHtmlEntities } from '@maimai-score-hub/shared';
import type { StatsCardDisplay } from '@maimai-score-hub/shared';
import { createHash } from 'node:crypto';

export const STATS_CARD_RENDERER_VERSION = '3';
export const MAX_SVG_BYTES = 256 * 1024;

/** Fixed origin and static raster paths only: never fetch a caller-supplied URL. */
export function statsAssetUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) {
    return null;
  }
  try {
    const url = new URL(value, 'https://maimai.wahlap.com');
    if (
      ![
        'https://maimai.wahlap.com',
        'https://maiscorehub.bakapiano.com',
      ].includes(url.origin) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/maimai-mobile\/img\/[A-Za-z0-9_/-]+\.(?:png|jpe?g)$/i.test(
        url.pathname,
      )
    ) {
      return null;
    }
    return 'https://maimai.wahlap.com' + url.pathname;
  } catch {
    return null;
  }
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return Array.from(
    decodeHtmlEntities(value.slice(0, 2048))
      // Strip control characters before measuring or converting glyphs.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim(),
  )
    .slice(0, max)
    .join('');
}

function count(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), max)
    : null;
}

/** An explicit projection, not a serialized user object. No identifiers or auth data. */
export function publicStatsProfile(input: unknown) {
  const p =
    input && typeof input === 'object'
      ? (input as Record<string, unknown>)
      : {};
  const colors: Record<string, string> = {
    bronze: '#f06418',
    copper: '#f06418',
    gold: '#ffab09',
    platina: '#d9d02f',
    silver: '#09b8ff',
    normal: '#656a7e',
  };
  const color =
    typeof p.titleColor === 'string' ? p.titleColor.toLowerCase() : '';
  return {
    username: text(p.username, 24) || '未知用户',
    title: text(p.title, 40),
    titleColor:
      colors[color] ??
      (/^#[a-f0-9]{6}$/.test(color) ? color : color ? '#8931b2' : '#656a7e'),
    rating: count(p.rating, 99999),
    awakeningCount: count(p.awakeningCount, 99999),
    avatarUrl: statsAssetUrl(p.avatarUrl),
    courseRankUrl: statsAssetUrl(p.courseRankUrl),
    classRankUrl: statsAssetUrl(p.classRankUrl),
  };
}
export type PublicStatsProfile = ReturnType<typeof publicStatsProfile>;
/** Apply the owner's saved visibility settings before fetching or rendering assets. */
export function visibleStatsProfile(
  profile: PublicStatsProfile,
  display: StatsCardDisplay,
): PublicStatsProfile {
  return {
    ...profile,
    rating: display.rating ? profile.rating : null,
    awakeningCount: display.awakeningCount ? profile.awakeningCount : null,
    classRankUrl: display.classRank ? profile.classRankUrl : null,
    courseRankUrl: display.courseRank ? profile.courseRankUrl : null,
    title: display.title ? profile.title : '',
    titleColor: display.title ? profile.titleColor : '#656a7e',
  };
}
export function statsHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
