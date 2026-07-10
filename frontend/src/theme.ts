import { Card, Paper, createTheme } from "@mantine/core";

export const CARD_RADIUS = "md" as const;

const systemSans =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'";

export const appTheme = createTheme({
  fontFamily: systemSans,
  headings: { fontFamily: systemSans },
  components: {
    Card: Card.extend({ defaultProps: { radius: CARD_RADIUS } }),
    Paper: Paper.extend({ defaultProps: { radius: CARD_RADIUS } }),
  },
});
