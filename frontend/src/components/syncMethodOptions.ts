import type { RadioCardOption } from "./RadioCardGroup";

export type SyncMethod =
  | "dxnet_bot"
  | "cabinet_qr"
  | "image_ocr"
  | "android_local";

const BASE_OPTIONS: RadioCardOption[] = [
  {
    value: "dxnet_bot",
    name: "DX Net",
    description: "通过 DX Net 好友成绩同步游戏数据",
  },
  {
    value: "cabinet_qr",
    name: "二维码",
    description: "使用机台二维码读取完整游戏成绩",
  },
  {
    value: "image_ocr",
    name: "成绩图识别",
    description: "从相册成绩图识别并上传成绩",
  },
];

const ANDROID_OPTION: RadioCardOption = {
  value: "android_local",
  name: "代理更新",
  description: "使用当前手机微信，通过本地代理更新成绩",
};

export function getSyncMethodOptions(
  androidAvailable: boolean,
): RadioCardOption[] {
  return androidAvailable
    ? [...BASE_OPTIONS, ANDROID_OPTION]
    : [...BASE_OPTIONS];
}
