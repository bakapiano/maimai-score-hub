import { Badge, Button, Indicator, Modal } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { useState } from "react";

import { useAndroidAppUpdate } from "./AndroidAppUpdateContext";
import { AndroidAppUpdatePanel } from "./AndroidAppUpdatePanel";
import {
  getAndroidAppUpdateBridge,
  getAndroidHostBridge,
} from "./androidUpdateBridge";

export function AndroidAppUpdateBadge() {
  const hostBridge = getAndroidHostBridge();
  const bridge = getAndroidAppUpdateBridge();
  const [opened, setOpened] = useState(false);
  const { updateAvailable } = useAndroidAppUpdate();

  if (!bridge) {
    return hostBridge ? (
      <Badge variant="light" color="teal">
        {hostBridge.getVersion()}
      </Badge>
    ) : null;
  }

  return (
    <>
      <Indicator
        inline
        color="red"
        size={8}
        offset={3}
        disabled={!updateAvailable}
      >
        <Button
          size="compact-sm"
          variant={updateAvailable ? "filled" : "light"}
          color={updateAvailable ? "blue" : "teal"}
          radius="xl"
          rightSection={<IconDownload size={14} />}
          onClick={() => setOpened(true)}
        >
          {bridge.getVersion()}{updateAvailable ? " · 可更新" : ""}
        </Button>
      </Indicator>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title="应用更新"
        centered
        size={440}
      >
        <AndroidAppUpdatePanel />
      </Modal>
    </>
  );
}
