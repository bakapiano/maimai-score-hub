import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { StatsCardService } from './stats-card.service';
import type { StatsCardArtifact } from './stats-card.schemas';
import { StatsCardRateLimit } from './stats-card.http';
import { DEFAULT_STATS_CARD_DISPLAY } from '@maimai-score-hub/shared';
import type { PublicStatsProfile } from './stats-card.profile';

type Artifact = StatsCardArtifact & { _id: Types.ObjectId };
function fixture() {
  const share = {
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId().toHexString(),
    enabled: true,
    generation: 1,
    code: 'a'.repeat(32),
    updatedAt: new Date(),
    display: { ...DEFAULT_STATS_CARD_DISPLAY },
  };
  let artifact: Artifact | null = null;
  let profile = { username: '测试玩家', rating: 15000 };
  let databaseFailed = false;
  const shares = {
    findOne: jest.fn(() =>
      query(() =>
        share.enabled ? { ...share, display: { ...share.display } } : null,
      ),
    ),
    exists: jest.fn((filter: { generation: number }) =>
      Promise.resolve(
        share.enabled && share.generation === filter.generation
          ? { _id: share._id }
          : null,
      ),
    ),
  };
  const users = {
    findById: jest.fn(() =>
      query(() => {
        if (databaseFailed) {
          throw new Error('database unavailable');
        }
        return { profile };
      }),
    ),
  };
  const artifacts = {
    findOne: jest.fn(() => query(() => (artifact ? { ...artifact } : null))),
    create: jest.fn((value: StatsCardArtifact) => {
      artifact = { ...value, _id: new Types.ObjectId() };
      return Promise.resolve(artifact);
    }),
    updateOne: jest.fn(
      (filter: { revision: string }, update: { $set: StatsCardArtifact }) => {
        if (artifact?.revision !== filter.revision) {
          return Promise.resolve({ modifiedCount: 0 });
        }
        artifact = { ...artifact, ...update.$set };
        return Promise.resolve({ modifiedCount: 1 });
      },
    ),
    deleteOne: jest.fn((filter: { revision: string }) => {
      if (artifact?.revision === filter.revision) {
        artifact = null;
      }
      return Promise.resolve();
    }),
  };
  const assets = {
    prepare: jest.fn((_profile: PublicStatsProfile) => {
      void _profile;
      return Promise.resolve({
        avatar: null,
        course: null,
        rank: null,
        signature: 'fixture',
      });
    }),
  };
  const renderer = {
    version: 'fixture',
    render: jest.fn(() =>
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ),
  };
  const newService = () =>
    new StatsCardService(
      shares as never,
      artifacts as never,
      users as never,
      assets as never,
      renderer as never,
    );
  return {
    share,
    shares,
    artifacts,
    assets,
    renderer,
    newService,
    getArtifact: () => artifact,
    setArtifact: (value: Artifact) => {
      artifact = value;
    },
    changeProfile: () => {
      profile = { ...profile, rating: profile.rating + 1 };
    },
    failDatabase: () => {
      databaseFailed = true;
    },
  };
}
function query<T>(read: () => T) {
  return {
    select: () => query(read),
    lean: () => query(read),
    exec: () => Promise.resolve().then(read),
  };
}

describe('stats card owner visibility fences', () => {
  it('excludes owner-hidden fields before both private preview and public rendering', async () => {
    const f = fixture();
    f.share.display.rating = false;
    const service = f.newService();
    await service.publicImage(f.share.code, 'light');
    await service.preview(f.share.userId, 'light');
    expect(f.assets.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ rating: null }),
    );
    expect(
      f.assets.prepare.mock.calls.every(([profile]) => profile.rating === null),
    ).toBe(true);
  });
  it('rejects a render when visibility was restricted on another replica', async () => {
    const f = fixture();
    f.assets.prepare.mockImplementation(() => {
      f.share.display.rating = false;
      f.share.generation++;
      return Promise.resolve({
        avatar: null,
        course: null,
        rank: null,
        signature: 'fixture',
      });
    });
    await expect(
      f.newService().publicImage(f.share.code, 'light'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.artifacts.create).not.toHaveBeenCalled();
  });
  it('refuses a private preview if saved visibility changes while it is rendering', async () => {
    const f = fixture();
    f.assets.prepare.mockImplementation(() => {
      f.share.display.rating = false;
      f.share.generation++;
      return Promise.resolve({
        avatar: null,
        course: null,
        rank: null,
        signature: 'fixture',
      });
    });
    await expect(
      f.newService().preview(f.share.userId, 'light'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('stats card service permission/cache fences', () => {
  it('shares persisted gzip across replicas without rendering again', async () => {
    const f = fixture();
    const a = await f.newService().publicImage(f.share.code, 'light');
    const b = await f.newService().publicImage(f.share.code, 'light');
    expect(a.etag).toBe(b.etag);
    expect(a.gzip.equals(b.gzip)).toBe(true);
    expect(f.renderer.render).toHaveBeenCalledTimes(1);
    expect(f.artifacts.create).toHaveBeenCalledTimes(1);
  });
  it('never returns a warmed cache entry after revocation', async () => {
    const f = fixture();
    const service = f.newService();
    await service.publicImage(f.share.code, 'light');
    f.share.enabled = false;
    await expect(
      service.publicImage(f.share.code, 'light'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.renderer.render).toHaveBeenCalledTimes(1);
  });
  it('fails closed when authoritative storage fails, even with a warm image', async () => {
    const f = fixture();
    const service = f.newService();
    await service.publicImage(f.share.code, 'light');
    f.failDatabase();
    await expect(service.publicImage(f.share.code, 'light')).rejects.toThrow(
      'database unavailable',
    );
  });
  it('refuses an in-flight render revoked during asset preparation', async () => {
    const f = fixture();
    f.assets.prepare.mockImplementation(() => {
      f.share.enabled = false;
      return Promise.resolve({
        avatar: null,
        course: null,
        rank: null,
        signature: 'fixture',
      });
    });
    await expect(
      f.newService().publicImage(f.share.code, 'light'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.artifacts.create).not.toHaveBeenCalled();
  });
  it('does not persist a profile that changed while rendering', async () => {
    const f = fixture();
    f.assets.prepare.mockImplementation(() => {
      f.changeProfile();
      return Promise.resolve({
        avatar: null,
        course: null,
        rank: null,
        signature: 'fixture',
      });
    });
    await expect(
      f.newService().publicImage(f.share.code, 'light'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.artifacts.create).not.toHaveBeenCalled();
  });
  it('preserves a newer concurrent artifact using the observed CAS revision', async () => {
    const f = fixture();
    await f.newService().publicImage(f.share.code, 'light');
    const old = f.getArtifact()!;
    f.setArtifact({ ...old, contentHash: 'outdated', revision: 'old' });
    f.renderer.render.mockImplementation(() => {
      f.setArtifact({ ...old, revision: 'newer-writer' });
      return Buffer.from('<svg/>');
    });
    await f.newService().publicImage(f.share.code, 'light');
    expect(f.artifacts.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 'old' }),
      expect.anything(),
    );
    expect(f.getArtifact()?.revision).toBe('newer-writer');
  });
  it('cleans its own late insert after revocation without retaining a readable artifact', async () => {
    const f = fixture();
    const create = f.artifacts.create.getMockImplementation()!;
    f.artifacts.create.mockImplementation(async (data) => {
      const inserted = await create(data);
      f.share.enabled = false;
      return inserted;
    });
    await expect(
      f.newService().publicImage(f.share.code, 'light'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.artifacts.deleteOne).toHaveBeenCalledTimes(1);
    expect(f.getArtifact()).toBeNull();
  });
  it('coalesces concurrent cold requests in one process', async () => {
    const f = fixture();
    const service = f.newService();
    const images = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.publicImage(f.share.code, 'light'),
      ),
    );
    expect(new Set(images.map((image) => image.etag)).size).toBe(1);
    expect(f.renderer.render).toHaveBeenCalledTimes(1);
  });
  it('bounds request rates independently for each account/IP bucket', () => {
    const rates = new StatsCardRateLimit();
    rates.take('user:1', 2);
    rates.take('user:1', 2);
    expect(() => rates.take('user:1', 2)).toThrow();
    expect(() => rates.take('user:2', 2)).not.toThrow();
  });
});
