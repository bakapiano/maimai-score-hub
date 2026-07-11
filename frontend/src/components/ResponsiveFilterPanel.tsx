import { Button, Modal } from "@mantine/core";
import { IconFilter } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { AppCard } from "./AppCard";

type FilterCardProps = {
  children: ReactNode;
};

type MobileFilterModalButtonProps = {
  children: ReactNode;
  active?: boolean;
  title?: string;
};

export function DesktopFilterCard({ children }: FilterCardProps) {
  return (
    <AppCard visibleFrom="sm">
      {children}
    </AppCard>
  );
}

export function MobileFilterModalButton({
  children,
  active = false,
  title = "筛选",
}: MobileFilterModalButtonProps) {
  const [opened, setOpened] = useState(false);

  return (
    <>
      <Button
        hiddenFrom="sm"
        variant={active ? "filled" : "light"}
        size="xs"
        leftSection={<IconFilter size={16} />}
        onClick={() => setOpened(true)}
      >
        筛选
      </Button>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={title}
        fullScreen
        transitionProps={{ transition: "fade", duration: 120 }}
      >
        {children}
      </Modal>
    </>
  );
}
