import "@mantine/core/styles.css";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { appTheme } from "../src/theme";
import { ProfileCard } from "../src/components/ProfileCard";
import type { UserProfile } from "../src/components/ProfileCard";

declare global {
  interface Window {
    statsCardComparison: {
      profile: UserProfile;
      theme: "light" | "dark";
      svg: string;
    };
  }
}

const { profile, theme, svg } = window.statsCardComparison;
// Test-only page: it imports the real frontend card/theme, not a copied HTML layout.
createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={appTheme} forceColorScheme={theme}>
    <main
      style={{
        padding: 24,
        background: theme === "dark" ? "#242424" : "#f8f9fa",
      }}
    >
      <div style={{ display: "flex", gap: 24 }}>
        <section style={{ width: 560 }}>
          <p>网页 ProfileCard（原组件）</p>
          <div id="reference">
            <ProfileCard profile={profile} />
          </div>
        </section>
        <section style={{ width: 560 }}>
          <p>SVG 外链（同宽）</p>
          <img
            id="svg-card"
            src={svg}
            alt="SVG 对照名片"
            style={{ display: "block", width: 560 }}
          />
        </section>
      </div>
    </main>
  </MantineProvider>,
);
