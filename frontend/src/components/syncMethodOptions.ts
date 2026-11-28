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
    description: "通过 DX Net 好友对比同步成绩",
  },
  {
    value: "cabinet_qr",
    name: "二维码",
    description: "通过二维码同步完整成绩",
  },
  {
    value: "image_ocr",
    name: "成绩图识别",
    description: "上传结算图自动识别并导入",
  },
];

const ANDROID_OPTION: RadioCardOption = {
  value: "android_local",
  name: "代理更新",
  description: "通过本机微信直接同步成绩",
};

export function getSyncMethodOptions(
  androidAvailable: boolean,
): RadioCardOption[] {
  return androidAvailable
    ? [...BASE_OPTIONS, ANDROID_OPTION]
    : [...BASE_OPTIONS];
}
