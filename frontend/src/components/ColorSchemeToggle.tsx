import {
  ActionIcon,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { IconMoonFilled, IconSunFilled } from "@tabler/icons-react";

export function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  // Resolve "auto" against system preference so the icon (and the
  // toggle target) reflects what the user actually SEES, not the raw
  // "auto" setting. With useMantineColorScheme alone, a user in
  // auto+system-dark would see the moon icon and clicking it would
  // flip auto → light (and stay light) instead of going to dark.
  const computed = useComputedColorScheme("light");
  const dark = computed === "dark";

  return (
    <ActionIcon
      variant="default"
      onClick={() => setColorScheme(dark ? "light" : "dark")}
      title="Toggle color scheme"
    >
      {dark ? <IconSunFilled size={18} /> : <IconMoonFilled size={18} />}
    </ActionIcon>
  );
}
