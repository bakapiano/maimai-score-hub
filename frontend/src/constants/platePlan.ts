export type PlatePlan = "jiang" | "ji" | "shen" | "wuwu";

export const PLAN_LABELS: Record<PlatePlan, string> = {
  jiang: "将牌 (≥100%)",
  ji: "极牌 (FC)",
  shen: "神牌 (AP)",
  wuwu: "舞舞牌 (FDX)",
};

export const PLAN_OPTIONS: { value: PlatePlan; label: string }[] = [
  { value: "jiang", label: "将牌 (≥100%)" },
  { value: "ji", label: "极牌 (FC)" },
  { value: "shen", label: "神牌 (AP)" },
  { value: "wuwu", label: "舞舞牌 (FDX)" },
];
