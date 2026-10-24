import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  StatsCardRenderer,
} = require('../dist/modules/stats-card/stats-card.renderer.js');
const {
  StatsCardAssets,
} = require('../dist/modules/stats-card/stats-card.assets.js');
const {
  publicStatsProfile,
} = require('../dist/modules/stats-card/stats-card.profile.js');
const root = path.resolve(import.meta.dirname, '../..');
const base = process.env.STATS_CARD_VISUAL_BASE ?? 'http://localhost:3001';
const variant = process.env.STATS_CARD_VISUAL_VARIANT ?? 'normal';
assert.ok(['normal', 'long', 'empty'].includes(variant));
const output = path.join(root, '.local-dev/stats-card-visual', variant);
mkdirSync(output, { recursive: true });
const originalProfile = {
  username: '舞萌玩家',
  title: '音游玩家',
  titleColor: 'gold',
  rating: 15432,
  awakeningCount: 42,
  avatarUrl: null,
  courseRankUrl:
    'https://maimai.wahlap.com/maimai-mobile/img/course/course_rank_20DkWvoJjc.png',
  classRankUrl: null,
  ratingBgUrl: null,
};
if (variant === 'long') {
  originalProfile.username = '今天也要努力成为更好的舞萌玩家呀';
  originalProfile.title = '热爱音乐，享受每一次相遇与每一次成长';
}
if (variant === 'empty') {
  Object.assign(originalProfile, {
    username: null,
    title: null,
    rating: null,
    awakeningCount: null,
    courseRankUrl: null,
  });
}
const profile = publicStatsProfile(originalProfile);
const assets = await new StatsCardAssets().prepare(profile);
// The same real avatar/class raster is supplied to both outputs. Other assets
// use the user's documented official course/star URLs and shared loaded bytes.
if (variant !== 'empty') {
  assets.avatar = readFileSync(
    path.join(root, 'backend/assets/mai/pic/UI_Icon_309503.png'),
  );
  assets.rank = readFileSync(
    path.join(root, 'backend/assets/mai/pic/UI_FBR_Class_00.png'),
  );
  assert.ok(
    assets.course && assets.star,
    'Official course/star assets must load for visual verification',
  );
}
const imageUrl = (bytes) =>
  bytes ? 'data:image/png;base64,' + bytes.toString('base64') : null;
const browser = await chromium.launch({
  executablePath:
    process.env.STATS_CARD_E2E_BROWSER ??
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
try {
  for (const theme of ['light', 'dark']) {
    const svg = new StatsCardRenderer().render(profile, assets, theme);
    const page = await browser.newPage({
      viewport: { width: 1220, height: 330 },
      deviceScaleFactor: 2,
    });
    const urls = {
      '/maimai-mobile/img/course/course_rank_20DkWvoJjc.png': assets.course,
      '/maimai-mobile/img/icon_star.png': assets.star,
    };
    await page.route('**/maimai-mobile/img/**', async (route) => {
      const image = urls[new URL(route.request().url()).pathname];
      if (image) {
        await route.fulfill({ contentType: 'image/png', body: image });
      } else {
        await route.abort();
      }
    });
    await page.addInitScript(
      (data) => {
        window.statsCardComparison = data;
      },
      {
        profile: {
          ...originalProfile,
          avatarUrl: imageUrl(assets.avatar),
          classRankUrl: imageUrl(assets.rank),
        },
        theme,
        svg: 'data:image/svg+xml;base64,' + svg.toString('base64'),
      },
    );
    await page.goto(base + '/test/stats-card-visual.html');
    await page.locator('#reference .mantine-Card-root').waitFor();
    // Compare the initial static frame, not two different marquee timestamps.
    await page.addStyleTag({
      content: '#reference * { animation: none !important; }',
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode()));
    });
    const measurements = await page.evaluate(() => {
      const card = document.querySelector('#reference .mantine-Card-root');
      const origin = card.getBoundingClientRect();
      return [card, ...card.querySelectorAll('*')].map((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          tag: el.tagName,
          classes: el.className,
          alt: el.getAttribute('alt'),
          x: r.x - origin.x,
          y: r.y - origin.y,
          w: r.width,
          h: r.height,
          font: s.font,
          color: s.color,
          background: s.background,
          border: s.border,
          radius: s.borderRadius,
          padding: s.padding,
          gap: s.gap,
          spacing: s.letterSpacing,
          naturalWidth: el.naturalWidth,
          naturalHeight: el.naturalHeight,
        };
      });
    });
    writeFileSync(
      path.join(output, theme + '-measurements.json'),
      JSON.stringify(measurements, null, 2),
    );
    writeFileSync(path.join(output, theme + '.svg'), svg);
    await page.screenshot({
      path: path.join(output, theme + '-comparison.png'),
    });
    await page
      .locator('#reference')
      .screenshot({ path: path.join(output, theme + '-frontend.png') });
    await page
      .locator('#svg-card')
      .screenshot({ path: path.join(output, theme + '-svg.png') });
    assert.equal(measurements[0].h, 150);
    const imageParts = await page.evaluate((source) => {
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      return [...doc.querySelectorAll('[data-part]')].map((el) => ({
        part: el.getAttribute('data-part'),
        x: Number(el.getAttribute('x')),
        y: Number(el.getAttribute('y')),
        w: Number(el.getAttribute('width')),
        h: Number(el.getAttribute('height')),
      }));
    }, svg.toString());
    for (const [part, selector] of [
      [
        'avatar-image',
        (m) =>
          m.tag === 'IMG' &&
          !['star', 'course rank', 'class rank'].includes(m.alt),
      ],
      ['course-rank', (m) => m.alt === 'course rank'],
      ['class-rank', (m) => m.alt === 'class rank'],
      ['star-image', (m) => m.alt === 'star'],
      [
        'title-background',
        (m) =>
          m.classes.includes('titleBadge') && m.classes.includes('Badge-root'),
      ],
      ['rating-background', (m) => m.classes.includes('ratingBadge')],
    ]) {
      const reference = measurements.find(selector);
      const rendered = imageParts.find((m) => m.part === part);
      if (!reference) {
        assert.equal(rendered, undefined);
        continue;
      }
      assert.ok(rendered, 'Missing SVG part: ' + part);
      for (const dimension of ['x', 'y', 'w', 'h']) {
        assert.ok(
          Math.abs(reference[dimension] - rendered[dimension]) < 0.05,
          part + '.' + dimension + ' drifted from the frontend',
        );
      }
    }
    const diff = await pixelDifference(output, theme);
    // Allow only minor SVG/HTML edge antialiasing differences. Layout checks above
    // are tighter (0.05 CSS px) so this cannot hide a shifted or oversized element.
    assert.ok(
      diff.fractionOver24 < 0.025,
      'Visual comparison exceeded 2.5% pixel tolerance',
    );
    console.log(
      'PASS ' +
        variant +
        '/' +
        theme +
        ': matching element geometry; ' +
        (diff.fractionOver24 * 100).toFixed(2) +
        '% pixels differ >24/255',
    );
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('Comparison saved to ' + output);

async function pixelDifference(directory, theme) {
  const reference = await sharp(path.join(directory, theme + '-frontend.png'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rendered = await sharp(path.join(directory, theme + '-svg.png'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(reference.info.width, rendered.info.width);
  assert.equal(reference.info.height, rendered.info.height);
  let count = 0;
  for (let i = 0; i < reference.data.length; i += 4) {
    if (
      [0, 1, 2].some(
        (channel) =>
          Math.abs(reference.data[i + channel] - rendered.data[i + channel]) >
          24,
      )
    ) {
      count++;
    }
  }
  return { fractionOver24: count / (reference.data.length / 4) };
}
