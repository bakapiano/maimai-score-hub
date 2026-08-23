import type {
  AndroidUpdateMode,
  AndroidUpdateStatus,
} from "./androidUpdateBridge";
import type { SyncStatusVisualState } from "../../components/SyncStatusSummary";

export type AndroidUpdatePresentation = {
  color: "gray" | "blue" | "green" | "red";
  label: string;
  text: string;
  badge: string | null;
  state: SyncStatusVisualState;
  progress: number;
};

export function getAndroidUpdatePresentation({
  mode,
  running,
  status,
}: {
  mode: AndroidUpdateMode;
  running: boolean;
  status: AndroidUpdateStatus | null;
}): AndroidUpdatePresentation {
  if (status?.terminal) {
    return status.success
      ? {
          color: "green",
          label: "已完成",
          text: status.message,
          badge: "更新完成",
          state: "completed",
          progress: 100,
        }
      : {
          color: "red",
          label: "失败",
          text: "代理更新任务未完成",
          badge: "更新失败",
          state: "failed",
          progress: 0,
        };
  }

  if (running || status) {
    const stage = getRunningStage(status?.message ?? "", mode);
    return {
      color: "blue",
      label: "代理更新中",
      text: status?.message || "正在等待手机返回更新状态…",
      badge: status?.stage
        ? stageLabel(status.stage, stage.label)
        : stage.label,
      state: "loading",
      progress: status?.progress ?? stage.progress,
    };
  }

  return {
    color: "gray",
    label: "等待代理更新",
    text:
      mode === "recent"
        ? "读取最近游玩并写入当前账号"
        : "读取全部难度成绩并写入当前账号",
    badge: null,
    state: "idle",
    progress: 0,
  };
}

function stageLabel(stage: string, fallback: string) {
  const labels: Record<string, string> = {
    workflow: "加载流程",
    prepare: "准备更新",
    oauth: "微信授权",
    session: "建立会话",
    identity: "读取身份",
    assign_bot: "分配 Bot",
    friend_request: "发送申请",
    wait_bot: "等待 Bot",
    catalog: "准备曲目",
    fetch_scores: "读取成绩",
    parse_scores: "解析成绩",
    upload: "保存成绩",
    verify: "校验版本",
  };
  return labels[stage] ?? fallback;
}

function getRunningStage(
  message: string,
  mode: AndroidUpdateMode,
): { label: string; progress: number } {
  if (/写入|保存成绩|版本校验/.test(message)) {
    return { label: "保存成绩", progress: 92 };
  }
  if (/全部成绩解析完成/.test(message)) {
    return { label: "保存成绩", progress: 90 };
  }
  const fullProgress = message.match(/全部成绩\s*([1-5])\/5/);
  if (fullProgress) {
    const completed = Number(fullProgress[1]);
    return {
      label: `读取成绩 ${completed}/5`,
      progress: 45 + completed * 8,
    };
  }
  if (/最近游玩解析完成/.test(message)) {
    return { label: "保存成绩", progress: 86 };
  }
  if (/读取最近游玩/.test(message)) {
    return { label: "读取成绩", progress: 62 };
  }
  if (/下载曲目目录/.test(message)) {
    return { label: "准备曲目", progress: 48 };
  }
  if (/校验 DXNET|读取当前微信.*身份|读取 DXNET 身份/.test(message)) {
    return { label: "校验账号", progress: 38 };
  }
  if (/授权完成|建立 DXNET 会话/.test(message)) {
    return { label: "建立会话", progress: 28 };
  }
  if (/微信|VPN|授权页|等待登录/.test(message)) {
    return { label: "微信授权", progress: 16 };
  }
  if (/网站登录状态|启动|准备|代理更新正在进行/.test(message)) {
    return { label: "准备更新", progress: 8 };
  }
  return {
    label: mode === "recent" ? "读取最近游玩" : "读取全部成绩",
    progress: 12,
  };
}
