import {
  Alert,
  Button,
  FileButton,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCamera, IconPhoto, IconUpload } from "@tabler/icons-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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

const ACCEPTED_IMAGES = "image/jpeg,image/png,image/webp";
const MAX_IMAGES = 20;

type ScoreOcrImportProps = {
  musics: readonly MusicRow[];
  disabled?: boolean;
  onImported: () => void | Promise<void>;
};

export function ScoreOcrImport({
  musics,
  disabled = false,
  onImported,
}: ScoreOcrImportProps) {
  const { token, offline } = useAuth();
  const [opened, setOpened] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<ScoreOcrDraft[]>([]);
  const [recognizing, setRecognizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const recognitionAbort = useRef<AbortController | null>(null);
  const cameraResetRef = useRef<() => void>(null);
  const albumResetRef = useRef<() => void>(null);

  const musicOptions = useMemo(
    () =>
      musics.map((music) => ({
        value: music.id,
        label: `${music.title} · ${music.type === "dx" ? "DX" : music.type === "utage" ? "宴" : "SD"} · ${music.id}`,
      })),
    [musics],
  );
  const musicMap = useMemo(
    () => new Map(musics.map((music) => [music.id, music])),
    [musics],
  );

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviewUrls(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);

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
    setDrafts([]);
    setError(null);
    setValidationErrors({});
    setRecognizing(false);
    setSaving(false);
    cameraResetRef.current?.();
    albumResetRef.current?.();
  }, []);

  const beginRecognition = useCallback(
    async (chosen: readonly File[]) => {
      if (!token || offline) {
        return;
      }
      const selected = chosen.slice(0, MAX_IMAGES);
      setFiles(selected);
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
        Object.fromEntries(result.errors.map((item) => [item.id, item.message])),
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
        submitError instanceof Error ? submitError.message : String(submitError),
      );
    } finally {
      setSaving(false);
    }
  }, [drafts, musics, onImported, reset, token]);

  const unavailable = disabled || offline || !token;
  const selectedCount = drafts.filter((draft) => draft.selected).length;

  return (
    <>
      <Group gap="xs">
        <FileButton
          onChange={(file) => {
            if (file) {
              void beginRecognition([file]);
            }
          }}
          accept={ACCEPTED_IMAGES}
          capture="environment"
          resetRef={cameraResetRef}
        >
          {(props) => (
            <Button
              {...props}
              size="xs"
              variant="light"
              leftSection={<IconCamera size={16} />}
              disabled={unavailable}
            >
              拍照识别
            </Button>
          )}
        </FileButton>
        <FileButton
          onChange={(selected) => void beginRecognition(selected)}
          accept={ACCEPTED_IMAGES}
          multiple
          resetRef={albumResetRef}
        >
          {(props) => (
            <Button
              {...props}
              size="xs"
              variant="light"
              leftSection={<IconPhoto size={16} />}
              disabled={unavailable}
            >
              相册批量识别
            </Button>
          )}
        </FileButton>
      </Group>

      <Modal
        opened={opened}
        onClose={reset}
        title="识别结算图并确认成绩"
        size="xl"
        closeOnClickOutside={!recognizing && !saving}
        closeOnEscape={!recognizing && !saving}
      >
        <Stack gap="md">
          {error ? <Alert color="red">{error}</Alert> : null}
          {recognizing ? (
            <Group justify="center" py="xl">
              <Loader />
              <Text>正在识别 {files.length} 张图片…</Text>
            </Group>
          ) : null}
          {drafts.length ? (
            <ScrollArea.Autosize mah="65vh" type="auto">
              <Stack gap="sm" pr="xs">
                {drafts.map((draft, index) => (
                  <ScoreOcrResultEditor
                    key={draft.id}
                    draft={draft}
                    previewUrl={previewUrls[index]}
                    musicOptions={musicOptions}
                    musicMap={musicMap}
                    validationError={validationErrors[draft.id]}
                    onChange={(patch) => updateDraft(draft.id, patch)}
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          ) : null}
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              已选择 {selectedCount} 条，提交前可以修改所有字段
            </Text>
            <Group>
              <Button variant="default" onClick={reset} disabled={saving}>
                取消
              </Button>
              <Button
                leftSection={<IconUpload size={16} />}
                onClick={() => void submit()}
                loading={saving}
                disabled={recognizing || drafts.length === 0}
              >
                确认并更新成绩
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
