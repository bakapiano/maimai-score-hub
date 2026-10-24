import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { StatsCardTheme } from '@maimai-score-hub/shared';
import {
  PROFILE_CARD_FONT,
  getProfileRatingGradient,
} from '@maimai-score-hub/shared';
import type { CardAssets } from './stats-card.assets';
import {
  MAX_SVG_BYTES,
  STATS_CARD_RENDERER_VERSION,
  type PublicStatsProfile,
} from './stats-card.profile';

const WIDTH = 560;
const HEIGHT = 150;
const CONTENT_X = 145;
const CONTENT_WIDTH = 394;

@Injectable()
export class StatsCardRenderer {
  readonly version = STATS_CARD_RENDERER_VERSION;

  render(
    profile: PublicStatsProfile,
    assets: CardAssets,
    theme: StatsCardTheme,
  ): Buffer {
    const svg = this.draw(profile, assets, theme);
    if (svg.length <= MAX_SVG_BYTES) {
      return svg;
    }
    const fallback = this.draw(
      profile,
      { avatar: null, course: null, rank: null, signature: '' },
      theme,
    );
    if (fallback.length > MAX_SVG_BYTES) {
      throw new ServiceUnavailableException('卡片内容过大，请稍后重试');
    }
    return fallback;
  }

  private draw(
    profile: PublicStatsProfile,
    assets: CardAssets,
    theme: StatsCardTheme,
  ): Buffer {
    const dark = theme === 'dark';
    const border = dark ? '#424242' : '#dee2e6';
    const ink = dark ? '#c9c9c9' : '#000000';
    const metaHeight = profile.title || profile.rating !== null ? 28 : 0;
    // Match the frontend's 108px Stack: meta, name, divider and rank row.
    const gap = (108 - metaHeight - 21.6 - 1 - 36) / 3;
    const nameY = 21 + metaHeight + gap;
    const dividerY = nameY + 21.6 + gap;
    return Buffer.from(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="150" viewBox="0 0 560 150" role="img" aria-label="maimai 个人名片">',
        '<defs>',
        clip('avatar', 21, 21, 108, 108, 8),
        clip('title', 156, 22, 138, 26),
        clip('name', CONTENT_X, nameY, CONTENT_WIDTH, 21.6),
        clip('ranks', CONTENT_X, 93, CONTENT_WIDTH, 36),
        '</defs>',
        '<g font-family="' + xml(PROFILE_CARD_FONT) + '" fill="' + ink + '">',
        rect(
          'card-background',
          0.5,
          0.5,
          WIDTH - 1,
          HEIGHT - 1,
          7.5,
          dark ? '#2e2e2e' : '#ffffff',
          ' stroke="' + border + '"',
        ),
        rect(
          'avatar-background',
          21,
          21,
          108,
          108,
          8,
          dark ? 'rgba(134,142,150,0.15)' : 'rgba(134,142,150,0.1)',
        ),
        '<g clip-path="url(#avatar)">',
        assets.avatar
          ? embed('avatar-image', assets.avatar, 21, 21, 108, 108)
          : placeholder(),
        '</g>',
        this.badges(profile),
        '<g clip-path="url(#name)">' +
          text('username', profile.username, CONTENT_X, nameY + 9.8, 18, 500) +
          '</g>',
        '<path data-part="divider" d="M145 ' +
          n(dividerY + 0.5) +
          'H539" fill="none" stroke="' +
          border +
          '" stroke-dasharray="3 3"/>',
        '<g clip-path="url(#ranks)">' + rankRow(profile, assets) + '</g>',
        '</g></svg>',
      ].join(''),
    );
  }

  private badges(profile: PublicStatsProfile): string {
    const title = profile.title
      ? [
          rect(
            'title-background',
            CONTENT_X,
            21,
            160,
            28,
            10,
            profile.titleColor,
            ' fill-opacity="0.13"',
          ),
          '<g clip-path="url(#title)" fill="' +
            xml(profile.titleColor) +
            '">' +
            text(
              'title-text',
              profile.title,
              156,
              34.5,
              13,
              700,
              ' letter-spacing="0.25" style="transform-box:fill-box;transform:translateX(max(0px,calc(69px - 50%)))"',
            ) +
            '</g>',
        ].join('')
      : '';
    if (profile.rating === null) {
      return title;
    }
    const gradient = getProfileRatingGradient(profile.rating);
    const x = profile.title ? 315 : CONTENT_X;
    // Content-sized badge, measured at 13px / Segoe UI including 20px padding.
    const width = 107.90625 + (String(profile.rating).length - 5) * 7.71875;
    // CSS linear-gradient(45deg), including its magic-corner endpoints.
    const half = (width + 28) / 4;
    const centerX = x + width / 2;
    return (
      title +
      [
        '<defs><linearGradient id="rating-gradient" gradientUnits="userSpaceOnUse" x1="' +
          n(centerX - half) +
          '" y1="' +
          n(35 + half) +
          '" x2="' +
          n(centerX + half) +
          '" y2="' +
          n(35 - half) +
          '">' +
          '<stop stop-color="' +
          gradient.from +
          '"/><stop offset="1" stop-color="' +
          gradient.to +
          '"/></linearGradient></defs>',
        rect(
          'rating-background',
          x,
          21,
          width,
          28,
          10,
          'url(#rating-gradient)',
        ),
        '<g fill="#ffffff">' +
          text(
            'rating-text',
            'Rating: ' + profile.rating,
            centerX,
            34.5,
            13,
            700,
            ' text-anchor="middle" letter-spacing="0.25"',
          ) +
          '</g>',
      ].join('')
    );
  }
}

function rankRow(profile: PublicStatsProfile, assets: CardAssets): string {
  let x = CONTENT_X;
  const images: string[] = [];
  if (assets.course) {
    const width = Math.min(imageWidth(assets.course, 36), CONTENT_WIDTH * 0.42);
    images.push(embed('course-rank', assets.course, x, 93, width, 36));
    x += width + 10;
  }
  if (assets.rank) {
    const width = imageWidth(assets.rank, 36);
    const frameWidth = Math.min(width, 78);
    images.push(
      '<defs>' +
        clip('class-frame', x, 93, frameWidth, 36) +
        '</defs>' +
        '<g clip-path="url(#class-frame)">' +
        embed('class-rank', assets.rank, x, 93, width, 36) +
        '</g>',
    );
    x += frameWidth + 10;
  }
  if (profile.awakeningCount !== null) {
    if (assets.star) {
      const width = imageWidth(assets.star, 30);
      images.push(embed('star-image', assets.star, x, 96, width, 30));
      x += width + 2;
    }
    images.push(
      text('star-count', '×' + profile.awakeningCount, x, 110.5, 16, 400),
    );
  }
  return images.join('');
}

function imageWidth(image: Buffer, height: number): number {
  // Sanitized assets are PNGs; IHDR preserves their aspect ratio without decoding.
  if (
    image.length >= 24 &&
    image.readUInt32BE(0) === 0x89504e47 &&
    image.readUInt32BE(20) > 0
  ) {
    return (image.readUInt32BE(16) / image.readUInt32BE(20)) * height;
  }
  return height;
}
function embed(
  part: string,
  image: Buffer,
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  return (
    '<image data-part="' +
    part +
    '" x="' +
    n(x) +
    '" y="' +
    n(y) +
    '" width="' +
    n(width) +
    '" height="' +
    n(height) +
    '" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,' +
    image.toString('base64') +
    '"/>'
  );
}
function placeholder(): string {
  // Exact shapes/colors from frontend/public/avatar-placeholder.svg.
  return (
    '<svg data-part="avatar-image" x="21" y="21" width="108" height="108" viewBox="0 0 128 128">' +
    '<rect width="128" height="128" rx="16" fill="#7ed3ff"/>' +
    '<circle cx="64" cy="50" r="22" fill="#fff" opacity="0.85"/>' +
    '<path d="M22 110Q22 78 64 78Q106 78 106 110L106 128L22 128Z" fill="#fff" opacity="0.85"/></svg>'
  );
}
function clip(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 0,
): string {
  return (
    '<clipPath id="' +
    id +
    '"><rect x="' +
    n(x) +
    '" y="' +
    n(y) +
    '" width="' +
    n(width) +
    '" height="' +
    n(height) +
    '" rx="' +
    radius +
    '"/></clipPath>'
  );
}
function rect(
  part: string,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
  extra = '',
): string {
  return (
    '<rect data-part="' +
    part +
    '" x="' +
    n(x) +
    '" y="' +
    n(y) +
    '" width="' +
    n(width) +
    '" height="' +
    n(height) +
    '" rx="' +
    radius +
    '" fill="' +
    xml(fill) +
    '"' +
    extra +
    '/>'
  );
}
function text(
  part: string,
  value: string,
  x: number,
  y: number,
  size: number,
  weight: number,
  extra = '',
): string {
  return (
    '<text data-part="' +
    part +
    '" x="' +
    n(x) +
    '" y="' +
    n(y) +
    '" font-size="' +
    size +
    '" font-weight="' +
    weight +
    '" dominant-baseline="central"' +
    extra +
    '>' +
    xml(value) +
    '</text>'
  );
}
function xml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[char]!,
  );
}
function n(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}
