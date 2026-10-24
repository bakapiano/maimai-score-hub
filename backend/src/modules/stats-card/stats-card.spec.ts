import { ByteLru } from './byte-lru';
import {
  publicStatsProfile,
  statsAssetUrl,
  MAX_SVG_BYTES,
  visibleStatsProfile,
} from './stats-card.profile';
import { StatsCardRenderer } from './stats-card.renderer';
import { StatsCardAssets } from './stats-card.assets';
import {
  StatsCardQuerySchema,
  StatsCardMutationSchema,
  StatsCardDisplayPatchSchema,
  DEFAULT_STATS_CARD_DISPLAY,
} from '@maimai-score-hub/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

describe('stats card bounded cache', () => {
  it('evicts by bytes in LRU order, handles replacement and refuses oversize entries', () => {
    const cache = new ByteLru<string>(10, 3);
    cache.set('a', 'A', 4);
    cache.set('b', 'B', 4);
    expect(cache.get('a')).toBe('A');
    cache.set('c', 'C', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.bytes).toBe(8);
    cache.set('a', 'small', 1);
    expect(cache.bytes).toBe(5);
    cache.set('oversize', 'X', 11);
    expect(cache.size).toBe(2);
    cache.deletePrefix('a');
    expect(cache.bytes).toBe(4);
  });
  it('bounds tiny entries by count and expires them', () => {
    jest.useFakeTimers();
    try {
      const cache = new ByteLru<number>(1024, 2, 10);
      cache.set('a', 1, 1);
      cache.set('b', 2, 1);
      cache.set('c', 3, 1);
      expect(cache.size).toBe(2);
      expect(cache.get('a')).toBeUndefined();
      jest.advanceTimersByTime(11);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBeUndefined();
      expect(cache.bytes).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('stats card public projection', () => {
  it.each([
    'http://127.0.0.1/maimai-mobile/img/icon.png',
    'https://maimai.wahlap.com.evil.invalid/maimai-mobile/img/a.png',
    'https://user:pass@maimai.wahlap.com/maimai-mobile/img/a.png',
    'https://maimai.wahlap.com/maimai-mobile/img/a.svg',
    'https://maimai.wahlap.com/maimai-mobile/img/a.png?userId=123',
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    '/api/v1/me',
  ])('rejects unsafe resource %s', (url) => {
    expect(statsAssetUrl(url)).toBeNull();
  });
  it('normalizes only allowlisted raster assets', () => {
    expect(statsAssetUrl('/maimai-mobile/img/icon/abc.png')).toBe(
      'https://maimai.wahlap.com/maimai-mobile/img/icon/abc.png',
    );
  });
  it('drops all private fields and bounds all render inputs', () => {
    const p = publicStatsProfile({
      friendCode: '799999999999901',
      cabinetUserId: 123,
      token: 'private',
      username: 'A'.repeat(500),
      title: '&lt;script&gt;',
      titleColor: 'url(evil)',
      rating: Infinity,
      awakeningCount: -1,
    });
    expect(Object.keys(p)).not.toEqual(
      expect.arrayContaining(['friendCode', 'cabinetUserId', 'token']),
    );
    expect(p.username).toHaveLength(24);
    expect(p.title).toBe('<script>');
    expect(p.rating).toBeNull();
    expect(p.awakeningCount).toBeNull();
    expect(p.titleColor).toBe('#8931b2');
  });
  it('rejects arbitrary cache variants and identity overrides', () => {
    expect(StatsCardQuerySchema.parse({})).toEqual({ theme: 'light' });
    expect(StatsCardQuerySchema.safeParse({ theme: 'custom' }).success).toBe(
      false,
    );
    expect(
      StatsCardQuerySchema.safeParse({ theme: 'light', friendCode: '123' })
        .success,
    ).toBe(false);
    expect(
      StatsCardMutationSchema.safeParse({ userId: 'someone-else' }).success,
    ).toBe(false);
  });
});

describe('stats SVG rendering', () => {
  let renderer: StatsCardRenderer;
  const emptyAssets = { avatar: null, course: null, rank: null, signature: '' };
  beforeAll(() => {
    renderer = new StatsCardRenderer();
  });
  it('removes hidden fields and URLs before rendering or asset fetching', () => {
    const p = publicStatsProfile({
      username: '测试玩家',
      rating: 15432,
      title: '专属称号',
      awakeningCount: 42,
      courseRankUrl: '/maimai-mobile/img/course/a.png',
      classRankUrl: '/maimai-mobile/img/class/a.png',
    });
    const hidden = visibleStatsProfile(p, {
      rating: false,
      title: false,
      awakeningCount: false,
      courseRank: false,
      classRank: false,
    });
    expect(hidden).toMatchObject({
      username: '测试玩家',
      rating: null,
      title: '',
      awakeningCount: null,
      courseRankUrl: null,
      classRankUrl: null,
    });
    const svg = renderer.render(hidden, emptyAssets, 'light').toString();
    expect(svg).not.toMatch(
      /15432|专属称号|rating-text|title-text|star-count|course-rank|class-rank/,
    );
    expect(visibleStatsProfile(p, { ...DEFAULT_STATS_CARD_DISPLAY })).toEqual(
      p,
    );
  });
  it('validates owner-only boolean display updates and rejects public overrides', () => {
    expect(StatsCardDisplayPatchSchema.parse({ rating: false })).toEqual({
      rating: false,
    });
    for (const invalid of [
      {},
      { rating: 'false' },
      { classRank: null },
      { userId: 'other', rating: true },
    ]) {
      expect(StatsCardDisplayPatchSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
    expect(
      StatsCardQuerySchema.safeParse({ theme: 'light', rating: true }).success,
    ).toBe(false);
  });
  it('is deterministic and self-contained, with escaped SVG text instead of active HTML', () => {
    const profile = publicStatsProfile({
      username: '<script>alert(1)</script>',
      title: '热爱音乐的舞萌玩家',
      rating: 15432,
      awakeningCount: 42,
      friendCode: '799999999999901',
    });
    const a = renderer.render(profile, emptyAssets, 'light');
    const b = renderer.render(profile, emptyAssets, 'light');
    expect(a.equals(b)).toBe(true);
    const svg = a.toString();
    expect(svg).toContain('<svg');
    expect(svg).toContain('<path');
    expect(svg).not.toMatch(/<script|foreignObject|799999999999901|@font-face/);
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('height="150"');
    expect(svg).toContain('Segoe UI');
    expect(a.length).toBeLessThanOrEqual(MAX_SVG_BYTES);
    expect(renderer.render(profile, emptyAssets, 'dark').equals(a)).toBe(false);
  });
  it('embeds actual raster bytes and enforces an output budget', () => {
    const avatar = readFileSync(
      join(process.cwd(), 'assets/mai/pic/UI_Icon_309503.png'),
    );
    const p = publicStatsProfile({
      username: '舞萌玩家',
      title: '舞萌'.repeat(30),
    });
    const svg = renderer
      .render(p, { ...emptyAssets, avatar }, 'light')
      .toString();
    expect(svg).toContain('data:image/png;base64,');
    expect(svg).not.toContain('https://');
    const bounded = renderer.render(
      p,
      { ...emptyAssets, avatar: Buffer.alloc(MAX_SVG_BYTES) },
      'light',
    );
    expect(bounded.length).toBeLessThanOrEqual(MAX_SVG_BYTES);
  });
});

describe('stats assets network limits', () => {
  it('normalizes the public site proxy without allowing arbitrary hosts', () => {
    expect(
      statsAssetUrl(
        'https://maiscorehub.bakapiano.com/maimai-mobile/img/course/course_rank_20DkWvoJjc.png',
      ),
    ).toBe(
      'https://maimai.wahlap.com/maimai-mobile/img/course/course_rank_20DkWvoJjc.png',
    );
  });
  it('loads original rank and star assets through the online fallback', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#6699cc' },
    })
      .png()
      .toBuffer();
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockImplementation((input) =>
        Promise.resolve(
          typeof input === 'string' &&
            input.startsWith('https://maimai.wahlap.com')
            ? new Response(null, { status: 503 })
            : new Response(new Uint8Array(png)),
        ),
      );
    const assets = await new StatsCardAssets().prepare(
      publicStatsProfile({
        courseRankUrl: '/maimai-mobile/img/course/course_rank_20DkWvoJjc.png',
        classRankUrl: '/maimai-mobile/img/class/class_rank_01.png',
        awakeningCount: 42,
      }),
    );
    expect(assets.course).not.toBeNull();
    expect(assets.rank).not.toBeNull();
    expect(assets.star).not.toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      'https://maiscorehub.bakapiano.com/maimai-mobile/img/icon_star.png',
      expect.anything(),
    );
    const svg = new StatsCardRenderer()
      .render(publicStatsProfile({ awakeningCount: 42 }), assets, 'light')
      .toString();
    expect(svg.match(/<image /g)).toHaveLength(3);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  it('does not fetch untrusted locations', async () => {
    const fetcher = jest.spyOn(global, 'fetch');
    await new StatsCardAssets().prepare(
      publicStatsProfile({ avatarUrl: 'http://localhost/secret' }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('disables redirects and rejects oversize bodies', async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { 'content-length': String(2 * 1024 * 1024) },
    });
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(response);
    const assets = await new StatsCardAssets().prepare(
      publicStatsProfile({
        avatarUrl: '/maimai-mobile/img/a.png',
      }),
    );
    expect(assets.avatar).toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      'https://maimai.wahlap.com/maimai-mobile/img/a.png',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
  it('re-encodes allowlisted images and reuses bounded asset cache', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#6699cc' },
    })
      .png()
      .toBuffer();
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array(png)));
    const loader = new StatsCardAssets();
    const p = publicStatsProfile({ avatarUrl: '/maimai-mobile/img/a.png' });
    const first = await loader.prepare(p);
    const second = await loader.prepare(p);
    expect(first.avatar).not.toBeNull();
    expect(first.signature).toBe(second.signature);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
