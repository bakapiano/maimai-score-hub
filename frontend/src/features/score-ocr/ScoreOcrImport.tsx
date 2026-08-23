import {
  ActionIcon,
  Alert,
  Box,
  Button,
  FileButton,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconPhoto, IconUpload, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/counter.css";

import {
  recognizeScoreImages,
  submitRecognizedScores,
} from "../../api/scoreOcr";
import { useAuth } from "../../providers/AuthContext";
import type { MusicRow } from "../../types/music";
import { ScoreOcrResultEditor } from "./ScoreOcrResultEditor";
import {
  buildManualScoreUpdates,
  buildScoreOcrDrafts,
  type ScoreOcrDraft,
} from "./scoreOcrModel";
import classes from "./ScoreOcrImport.module.css";

const ACCEPTED_IMAGES = "image/jpeg,image/png,image/webp";
const MAX_IMAGES = 20;
const PREVIEW_MAX_EDGE = 640;
const LIGHTBOX_PLUGINS = [Zoom, Counter];

type ScoreOcrImportProps = {
  musics: readonly MusicRow[];
  disabled?: boolean;
  onImported: () => void | Promise<void>;
};

type LightboxSlide = { src: string; alt: string };

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片预览读取失败"));
    reader.readAsDataURL(file);
  });
}

async function createStablePreview(file: File): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(
      1,
      PREVIEW_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return readFileAsDataUrl(file);
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return readFileAsDataUrl(file);
  }
}

function ScoreImageLightbox({
  index,
  slides,
  onClose,
}: {
  index: number | null;
  slides: LightboxSlide[];
  onClose: () => void;
}) {
  return (
    <Lightbox
      open={index !== null && slides.length > 0}
      close={onClose}
      index={index ?? 0}
      slides={slides}
      plugins={LIGHTBOX_PLUGINS}
      carousel={{ finite: true }}
      controller={{ closeOnBackdropClick: true }}
      zoom={{
        maxZoomPixelRatio: 5,
        scrollToZoom: true,
        pinchZoomV4: true,
      }}
      render={
        slides.length > 1
          ? undefined
          : { buttonPrev: () => null, buttonNext: () => null }
      }
      labels={{
        Close: "关闭",
        Next: "下一张",
        Previous: "上一张",
        "Zoom in": "放大",
        "Zoom out": "缩小",
      }}
    />
  );
}

function OcrModalFooter({
  saving,
  recognizing,
  hasDrafts,
  onCancel,
  onSubmit,
}: {
  saving: boolean;
  recognizing: boolean;
  hasDrafts: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <Group className={classes.modalFooter} justify="flex-end">
      <Group className={classes.footerActions} gap="sm">
        <Button variant="default" onClick={onCancel} disabled={saving}>
          取消
        </Button>
        <Button
          leftSection={<IconUpload size={16} />}
          onClick={onSubmit}
          loading={saving}
          disabled={recognizing || !hasDrafts}
        >
          更新
        </Button>
      </Group>
    </Group>
  );
}

export function ScoreOcrImport({
  musics,
  disabled = false,
  onImported,
}: ScoreOcrImportProps) {
  const { token, offline } = useAuth();
  const fullScreen = useMediaQuery("(max-width: 48em)");
  const [opened, setOpened] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<ScoreOcrDraft[]>([]);
  const [recognizing, setRecognizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const recognitionAbort = useRef<AbortController | null>(null);
  const imageResetRef = useRef<() => void>(null);

  const musicMap = useMemo(
    () => new Map(musics.map((music) => [music.id, music])),
    [musics],
  );
  const lightboxSlides = useMemo(
    () =>
      previewUrls.map((src, index) => ({
        src,
        alt: files[index]?.name ?? `结算图 ${index + 1}`,
      })),
    [files, previewUrls],
  );

  useEffect(
    () => () => {
      recognitionAbort.current?.abort();
    },
    [],
  );

  const reset = useCallback(() => {
    recognitionAbort.current?.abort();
    recognitionAbort.current = null;
    setOpened(false);
    setFiles([]);
    setPreviewUrls([]);
    setDrafts([]);
    setError(null);
    setValidationErrors({});
    setRecognizing(false);
    setSaving(false);
    setLightboxIndex(null);
    imageResetRef.current?.();
  }, []);

  const beginRecognition = useCallback(
    async (chosen: readonly File[]) => {
      if (!token || offline) {
        return;
      }
      const selected = chosen.slice(0, MAX_IMAGES);
      setFiles(selected);
      setPreviewUrls([]);
      setLightboxIndex(null);
      setDrafts([]);
      setError(
        chosen.length > MAX_IMAGES
          ? `一次最多识别 ${MAX_IMAGES} 张，已选择前 ${MAX_IMAGES} 张`
          : null,
      );
      setValidationErrors({});
      setOpened(true);
      setRecognizing(true);
      recognitionAbort.current?.abort();
      const controller = new AbortController();
      recognitionAbort.current = controller;
      void Promise.all(selected.map(createStablePreview)).then((urls) => {
        if (!controller.signal.aborted) {
          setPreviewUrls(urls);
        }
      }).catch(() => {
        if (!controller.signal.aborted) {
          setPreviewUrls([]);
        }
      });
      try {
        const response = await recognizeScoreImages({
          token,
          files: selected,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setDrafts(buildScoreOcrDrafts(response.results, musics));
        }
      } catch (recognitionError) {
        if (!controller.signal.aborted) {
          setError(
            recognitionError instanceof Error
              ? recognitionError.message
              : String(recognitionError),
          );
        }
      } finally {
        if (recognitionAbort.current === controller) {
          recognitionAbort.current = null;
          setRecognizing(false);
        }
      }
    },
    [musics, offline, token],
  );

  const updateDraft = useCallback(
    (id: string, patch: Partial<ScoreOcrDraft>) => {
      setDrafts((current) =>
        current.map((draft) =>
          draft.id === id ? { ...draft, ...patch } : draft,
        ),
      );
      setValidationErrors((current) => {
        if (!(id in current)) {
          return current;
        }
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    [],
  );

  const submit = useCallback(async () => {
    if (!token) {
      return;
    }
    const result = buildManualScoreUpdates(drafts, musics);
    if (result.errors.length) {
      setValidationErrors(
        Object.fromEntries(
          result.errors.map((item) => [item.id, item.message]),
        ),
      );
      setError("请检查标红的识别结果");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await submitRecognizedScores({
        token,
        scores: result.scores,
      });
      notifications.show({
        title: "成绩已更新",
        message: `提交 ${response.submittedChartCount} 个谱面，更新 ${response.changedChartCount} 个谱面`,
        color: "green",
      });
      await onImported();
      reset();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
    } finally {
      setSaving(false);
    }
  }, [drafts, musics, onImported, reset, token]);

  const unavailable = disabled || offline || !token;

  return (
    <>
      <FileButton
        onChange={(selected) => void beginRecognition(selected)}
        accept={ACCEPTED_IMAGES}
        multiple
        resetRef={imageResetRef}
      >
        {(props) => (
          <Button
            {...props}
            variant="light"
            leftSection={<IconPhoto size={16} />}
            disabled={unavailable}
            w={{ base: "100%", xs: "auto" }}
            styles={{ root: { flexShrink: 0 } }}
          >
            选择成绩图
          </Button>
        )}
      </FileButton>

      <Modal.Root
        opened={opened}
        onClose={reset}
        fullScreen={fullScreen}
        centered={!fullScreen}
        lockScroll
        trapFocus={lightboxIndex === null}
        size="xl"
        classNames={{
          inner: classes.modalInner,
          content: classes.modalContent,
          header: classes.modalHeader,
          body: classes.modalBody,
        }}
        transitionProps={{
          transition: fullScreen ? "slide-up" : "fade-down",
          duration: 180,
        }}
        closeOnClickOutside={lightboxIndex === null && !recognizing && !saving}
        closeOnEscape={lightboxIndex === null && !recognizing && !saving}
      >
        <Modal.Overlay
          backgroundOpacity={fullScreen ? 0 : 0.55}
          blur={fullScreen ? 0 : 3}
        />
        <Modal.Content>
          <Modal.Header>
            <Modal.Title>
              <Text fw={700}>成绩图识别</Text>
            </Modal.Title>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={reset}
              disabled={saving}
              aria-label="关闭"
            >
              <IconX size={18} />
            </ActionIcon>
          </Modal.Header>
          <Modal.Body>
            <Box className={classes.modalScroll}>
              <Stack gap="md">
                {error ? <Alert color="red">{error}</Alert> : null}
                {recognizing ? (
                  <Group justify="center" py="xl">
                    <Loader />
                    <Text>正在识别 {files.length} 张图片…</Text>
                  </Group>
                ) : null}
                {drafts.map((draft, index) => (
                  <ScoreOcrResultEditor
                    key={draft.id}
                    draft={draft}
                    previewIndex={index}
                    previewUrl={previewUrls[index]}
                    musicMap={musicMap}
                    validationError={validationErrors[draft.id]}
                    onChange={updateDraft}
                    onPreview={setLightboxIndex}
                  />
                ))}
              </Stack>
            </Box>
            <OcrModalFooter
              saving={saving}
              recognizing={recognizing}
              hasDrafts={drafts.length > 0}
              onCancel={reset}
              onSubmit={() => void submit()}
            />
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>

      <ScoreImageLightbox
        index={lightboxIndex}
        slides={lightboxSlides}
        onClose={() => setLightboxIndex(null)}
      />
    </>
  );
}
