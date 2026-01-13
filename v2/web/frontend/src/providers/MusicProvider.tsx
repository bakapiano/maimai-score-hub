import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { MusicRow, MusicChartPayload } from "../types/music";
import { fetchJson } from "../utils/fetch";

type MusicContextValue = {
  musics: MusicRow[];
  musicMap: Map<string, MusicRow>;
  chartMap: Map<string, MusicChartPayload & { musicId: string; chartIndex: number }>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

const MusicContext = createContext<MusicContextValue | undefined>(undefined);

export function MusicProvider({ children }: { children: React.ReactNode }) {
  const [musics, setMusics] = useState<MusicRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMusics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchJson<MusicRow[]>("/api/music");
      if (res.ok && Array.isArray(res.data)) {
        setMusics(res.data);
      } else {
        setError(`获取曲库失败 (HTTP ${res.status})`);
        setMusics([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取曲库失败");
      setMusics([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMusics();
  }, [loadMusics]);

  // Build lookup maps
  const { musicMap, chartMap } = useMemo(() => {
    const mMap = new Map<string, MusicRow>();
    const cMap = new Map<string, MusicChartPayload & { musicId: string; chartIndex: number }>();

    for (const music of musics) {
      mMap.set(music.id, music);
      if (Array.isArray(music.charts)) {
        music.charts.forEach((chart, idx) => {
          // Key by musicId + chartIndex
          const key = `${music.id}:${idx}`;
          cMap.set(key, { ...chart, musicId: music.id, chartIndex: idx });
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
    [musics, musicMap, chartMap, loading, error, loadMusics]
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
