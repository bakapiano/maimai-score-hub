import { Button, type ButtonProps } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { useState } from "react";

import { notifications } from "@mantine/notifications";
import { usePwaInstall } from "../hooks/usePwaInstall";

type InstallAppButtonProps = {
  fullWidth?: boolean;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
};

export function InstallAppButton({
  fullWidth,
  size = "sm",
  variant = "light",
}: InstallAppButtonProps) {
  const { status, install } = usePwaInstall();
  const [installing, setInstalling] = useState(false);

  if (status === "installed" || status === "unavailable") {return null;}

  const handleInstall = async () => {
    if (status === "ios") {
      notifications.show({
        title: "可添加到主屏幕",
        message: "请使用浏览器分享菜单中的“添加到主屏幕”。",
        color: "blue",
      });
      return;
    }

    setInstalling(true);
    const outcome = await install();
    setInstalling(false);

    if (outcome === "accepted") {
      notifications.show({
        title: "开始安装",
        message: "浏览器正在安装 maimai Score Hub。",
        color: "green",
      });
    } else if (outcome === "error") {
      notifications.show({
        title: "安装失败",
        message: "浏览器没有完成安装请求。",
        color: "red",
      });
    }
  };

  return (
    <Button
      variant={variant}
      size={size}
      fullWidth={fullWidth}
      leftSection={<IconDownload size={16} />}
      loading={installing}
      onClick={handleInstall}
    >
      安装应用
    </Button>
  );
}
