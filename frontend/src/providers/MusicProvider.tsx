import { musicApi } from "../api/appClient";
import type { MusicChartPayload, MusicRow } from "../types/music";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MusicContext } from "./MusicContext";
import {
  cacheMusicList,
  getCachedMusicList,
} from "../utils/offlineCache";
import { runWhenIdle, scheduleIdleTask } from "../utils/idle";

let musicListRequest: Promise<MusicRow[]> | null = null;

function areMusicRowsEqual(a: MusicRow | undefined, b: MusicRow | undefined) {
  return (
    a?.id === b?.id &&
    a?.title === b?.title &&
    a?.type === b?.type &&
    a?.version === b?.version &&
    a?.charts?.length === b?.charts?.length
  );
}

function areMusicListsEqual(a: MusicRow[], b: MusicRow[]) {
  if (a === b) {return true;}
  if (a.length !== b.length) {return false;}

  for (let i = 0; i < a.length; i += 1) {
    if (!areMusicRowsEqual(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

function readCachedMusicListWhenIdle() {
  return runWhenIdle(() => getCachedMusicList<MusicRow>(), 300);
}

function cacheMusicListWhenIdle(musics: MusicRow[]) {
  scheduleIdleTask(() => cacheMusicList(musics), 1000);
}

async function requestMusicList() {
  if (!musicListRequest) {
    const nextRequest: Promise<MusicRow[]> = musicApi
      .listAll({})
      .then((res: { status: number; body?: unknown }) => {
        if (res.status !== 200 || !Array.isArray(res.body)) {
          throw new Error(`获取曲库失败 (HTTP ${res.status})`);
        }
        return res.body as MusicRow[];
      })
      .finally(() => {
        if (musicListRequest === nextRequest) {
          musicListRequest = null;
        }
      });

    musicListRequest = nextRequest;
  }

  return musicListRequest;
}

export function MusicProvider({ children }: { children: React.ReactNode }) {
  const [musics, setMusics] = useState<MusicRow[]>([]);
  const musicsRef = useRef<MusicRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMusics = useCallback(async () => {
    if (musicsRef.current.length === 0) {
      setLoading(true);
    }
    setError(null);

    try {
      const nextMusics = await requestMusicList();
      cacheMusicListWhenIdle(nextMusics);
      setMusics((current) =>
        areMusicListsEqual(current, nextMusics) ? current : nextMusics,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取曲库失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    musicsRef.current = musics;
  }, [musics]);

  useEffect(() => {
    let cancelled = false;

    readCachedMusicListWhenIdle().then((cachedMusics) => {
      if (cancelled || !cachedMusics || cachedMusics.length === 0) {
        return;
      }

      setMusics((current) =>
        current.length === 0 ? cachedMusics : current,
      );
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    loadMusics();
  }, [loadMusics]);

  // Build lookup maps
  const { musicMap, chartMap } = useMemo(() => {
    const mMap = new Map<string, MusicRow>();
    const cMap = new Map<
      number,
      MusicChartPayload & { musicId: string; chartIndex: number }
    >();

    for (const music of musics) {
      mMap.set(music.id, music);
      if (Array.isArray(music.charts)) {
        music.charts.forEach((chart, idx) => {
          // Key by cid (chart ID)
          if (chart.cid !== null && chart.cid !== undefined) {
            cMap.set(chart.cid, {
              ...chart,
              musicId: music.id,
              chartIndex: idx,
            });
          }
        });
      }
    }

    return { musicMap: mMap, chartMap: cMap };
  }, [musics]);

  const value = useMemo(
    () => ({
      musics,
      musicMap,
      chartMap,
      loading,
      error,
      reload: loadMusics,
    }),
    [musics, musicMap, chartMap, loading, error, loadMusics],
  );

  return (
    <MusicContext.Provider value={value}>{children}</MusicContext.Provider>
  );
}
