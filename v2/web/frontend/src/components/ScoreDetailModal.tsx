import { ActionIcon, Box, Modal, ScrollArea } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import {
  DetailedMusicScoreCard,
  type DetailedMusicScoreCardProps,
} from "./MusicScoreCard";

export interface ScoreDetailModalProps {
  opened: boolean;
  onClose: () => void;
  scoreData: DetailedMusicScoreCardProps | null;
}

export function ScoreDetailModal({
  opened,
  onClose,
  scoreData,
}: ScoreDetailModalProps) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      centered
      size="auto"
      padding={0}
      withCloseButton={false}
      radius="lg"
      overlayProps={{
        backgroundOpacity: 0.65,
        blur: 3,
      }}
      transitionProps={{
        transition: "pop",
        duration: 200,
      }}
      styles={{
        content: {
          backgroundColor: "transparent",
          boxShadow: "none",
          maxHeight: "90vh",
          overflow: "visible",
        },
        body: {
          padding: 0,
        },
      }}
      onClick={onClose}
    >
      {scoreData && (
        <Box
          onClick={(e) => e.stopPropagation()}
          style={{ position: "relative" }}
        >
          {/* Close Button */}
          <ActionIcon
            variant="filled"
            color="dark"
            radius="xl"
            size="lg"
            onClick={onClose}
            style={{
              position: "absolute",
              top: -12,
              right: -12,
              zIndex: 1000,
              backgroundColor: "rgba(0,0,0,0.7)",
              border: "2px solid rgba(255,255,255,0.3)",
            }}
            aria-label="关闭"
          >
            <IconX size={18} color="white" />
          </ActionIcon>

          <ScrollArea.Autosize
            mah="85vh"
            offsetScrollbars
            scrollbarSize={8}
            styles={{
              scrollbar: {
                backgroundColor: "rgba(255,255,255,0.1)",
                borderRadius: 4,
                "&[data-orientation='vertical']": {
                  width: 8,
                },
                "&:hover": {
                  backgroundColor: "rgba(255,255,255,0.15)",
                },
              },
              thumb: {
                backgroundColor: "rgba(255,255,255,0.4)",
                borderRadius: 4,
                "&:hover": {
                  backgroundColor: "rgba(255,255,255,0.6)",
                },
              },
            }}
          >
            <DetailedMusicScoreCard {...scoreData} />
          </ScrollArea.Autosize>
        </Box>
      )}
    </Modal>
  );
}
