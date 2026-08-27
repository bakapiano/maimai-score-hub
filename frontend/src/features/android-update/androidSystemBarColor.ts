export function cssColorToOpaqueHex(value: string): string | null {
  const normalized = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return normalized.toUpperCase();
  }
  if (!/^rgba?\(/i.test(normalized)) {
    return null;
  }
  const channels = normalized.match(/(?:\d*\.)?\d+/g)?.map(Number) ?? [];
  if (channels.length < 3 || channels.length > 4) {
    return null;
  }
  const [red, green, blue, alpha = 1] = channels;
  if (
    ![red, green, blue].every(
      (channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255,
    ) ||
    alpha !== 1
  ) {
    return null;
  }
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}
