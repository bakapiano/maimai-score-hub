/** Match the site's system UI typography, without a separate rounded export font. */
export const PROFILE_CARD_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'";

export function getProfileRatingGradient(rating: number) {
  if (rating < 1000) {
    return { from: "#9bdcf7", to: "#9bdcf7" };
  }
  if (rating < 2000) {
    return { from: "#4ea3ff", to: "#2364d2" };
  }
  if (rating < 4000) {
    return { from: "#b7e84f", to: "#2f9e44" };
  }
  if (rating < 7000) {
    return { from: "#ffe066", to: "#f08c00" };
  }
  if (rating < 10000) {
    return { from: "#ff8787", to: "#e03131" };
  }
  if (rating < 12000) {
    return { from: "#da77f2", to: "#862e9c" };
  }
  if (rating < 13000) {
    return { from: "#c08457", to: "#7c4a2d" };
  }
  if (rating < 14000) {
    return { from: "#9bdcf7", to: "#2364d2" };
  }
  if (rating < 14500) {
    return { from: "#ffd43b", to: "#f08c00" };
  }
  if (rating < 15000) {
    return { from: "#fff3bf", to: "#fab005" };
  }
  return { from: "#ae3ec9", to: "#15aabf" };
}
