import { FileButton, Loader, TextInput, UnstyledButton } from "@mantine/core";
import { IconQrcode, IconUpload } from "@tabler/icons-react";
import styles from "./QrCredentialInput.module.css";

export function QrCredentialInput({
  label,
  value,
  onChange,
  onFile,
  onEnter,
  disabled = false,
  loading = false,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  onFile: (file: File) => void;
  onEnter?: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <TextInput
      label={label}
      placeholder="粘贴二维码字符串"
      leftSection={<IconQrcode size={16} />}
      rightSectionWidth={108}
      rightSectionPointerEvents="all"
      rightSection={
        <FileButton
          accept="image/png,image/jpeg,image/webp"
          onChange={(file) => {
            if (file) {
              onFile(file);
            }
          }}
        >
          {(props) => (
            <UnstyledButton
              {...props}
              className={styles.uploadAction}
              disabled={disabled || loading}
              aria-label={loading ? "正在上传二维码图片" : "上传二维码图片"}
            >
              {loading ? <Loader size={14} /> : <IconUpload size={14} />}
              <span>{loading ? "上传中" : "上传图片"}</span>
            </UnstyledButton>
          )}
        </FileButton>
      }
      autoComplete="off"
      value={value}
      disabled={disabled || loading}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && value.trim() && onEnter) {
          onEnter();
        }
      }}
      styles={{ input: { paddingRight: 112 } }}
    />
  );
}
