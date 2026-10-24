import { Card, Paper, createTheme } from "@mantine/core";
import { PROFILE_CARD_FONT } from "@maimai-score-hub/shared";

export const CARD_RADIUS = "md" as const;

const systemSans = PROFILE_CARD_FONT;

export const appTheme = createTheme({
  fontFamily: systemSans,
  headings: { fontFamily: systemSans },
  components: {
    Card: Card.extend({
      defaultProps: { radius: CARD_RADIUS, shadow: "none" },
      styles: { root: { boxShadow: "none" } },
    }),
    Paper: Paper.extend({ defaultProps: { radius: CARD_RADIUS } }),
  },
});
