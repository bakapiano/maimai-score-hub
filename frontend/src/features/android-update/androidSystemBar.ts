import { getAndroidSystemBarBridge } from "./androidUpdateBridge";
import { cssColorToOpaqueHex } from "./androidSystemBarColor";

export function syncAndroidStatusBar(
  header: HTMLElement,
  darkIcons: boolean,
): boolean {
  const bridge = getAndroidSystemBarBridge();
  const backgroundColor = cssColorToOpaqueHex(
    window.getComputedStyle(header).backgroundColor,
  );
  if (!bridge || !backgroundColor) {
    return false;
  }
  try {
    bridge.setStatusBarStyle(backgroundColor, darkIcons);
    return true;
  } catch {
    return false;
  }
}
