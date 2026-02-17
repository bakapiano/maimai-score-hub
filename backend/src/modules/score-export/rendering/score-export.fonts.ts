import * as Canvas from '@napi-rs/canvas';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FONT_DIR = join(process.cwd(), 'assets', 'fonts');
let fontsLoaded = false;

export function ensureFontsLoaded() {
  if (fontsLoaded) return;

  const fonts = (
    Canvas as unknown as {
      GlobalFonts?: {
        loadFontsFromDir?: (dir: string) => void;
        families?: { family: string }[];
      };
    }
  ).GlobalFonts;

  if (!existsSync(FONT_DIR)) {
    console.warn(`[Fonts] Font directory not found: ${FONT_DIR}`);
    fontsLoaded = true;
    return;
  }

  if (fonts?.loadFontsFromDir) {
    fonts.loadFontsFromDir(FONT_DIR);
  }

  fontsLoaded = true;
}
