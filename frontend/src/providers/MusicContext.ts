import { createContext, useContext } from "react";

import type { MusicChartPayload, MusicRow } from "../types/music";

export type MusicContextValue = {
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

export const MusicContext = createContext<MusicContextValue | undefined>(
  undefined,
);

export function useMusic() {
  const ctx = useContext(MusicContext);
  if (!ctx) {
    throw new Error("useMusic must be used within MusicProvider");
  }
  return ctx;
}
