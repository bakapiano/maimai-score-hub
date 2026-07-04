import { musicApi } from "../api/appClient";
import type { MusicChartPayload, MusicRow } from "../types/music";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cacheMusicList,
  getCachedMusicList,
} from "../utils/offlineCache";

type MusicContextValue = {
  musics: MusicRow[];
  musicMap: Map<string, MusicRow>;
  chartMap: Map<
    number,
    MusicChartPayload & { musicId: string; chartIndex: number }
  >;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

const MusicContext = createContext<MusicContextValue | undefined>(undefined);

let musicListRequest: Promise<MusicRow[]> | null = null;

function areMusicListsEqual(a: MusicRow[], b: MusicRow[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
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
  const [initialCachedMusics] = useState<MusicRow[] | null>(() =>
    getCachedMusicList<MusicRow>(),
  );
  const [musics, setMusics] = useState<MusicRow[]>(
    () => initialCachedMusics ?? [],
  );
  const musicsRef = useRef<MusicRow[]>(initialCachedMusics ?? []);
  const [loading, setLoading] = useState(() => initialCachedMusics === null);
  const [error, setError] = useState<string | null>(null);

  const loadMusics = useCallback(async () => {
    if (musicsRef.current.length === 0) {
      setLoading(true);
    }
    setError(null);

    try {
      const nextMusics = await requestMusicList();
      cacheMusicList(nextMusics);
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
          if (chart.cid != null) {
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

export function useMusic() {
  const ctx = useContext(MusicContext);
  if (!ctx) {
    throw new Error("useMusic must be used within MusicProvider");
  }
  return ctx;
}
