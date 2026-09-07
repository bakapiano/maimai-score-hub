/** Explain export creation failures without guessing that credentials are wrong. */
export function getProberExportCreateError(status: number, body: unknown): string {
  const rawMessage =
    body && typeof body === "object" && "message" in body
      ? body.message
      : undefined;
  const message =
    typeof rawMessage === "string"
      ? rawMessage.trim()
      : Array.isArray(rawMessage)
        ? rawMessage
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
            .join("；")
        : "";

  if (
    status === 404 &&
    (message === "Sync not found" || message === "No sync found")
  ) {
    return "请先完成一次成绩同步，再导出到查分器。";
  }

  if (status === 400 && message === "User missing divingFishImportToken") {
    return "请先配置水鱼查分器的导入 Token。";
  }
  if (status === 400 && message === "User missing lxnsImportToken") {
    return "请先配置落雪查分器的导入 Token。";
  }

  if (status >= 200 && status < 300) {
    return "导出服务响应异常，请稍后重试。";
  }

  return message || `创建导出任务失败（HTTP ${status}），请稍后重试。`;
}
