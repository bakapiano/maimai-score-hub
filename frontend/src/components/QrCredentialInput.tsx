import { Button, FileButton, Group, PasswordInput } from "@mantine/core";
import { IconQrcode, IconUpload } from "@tabler/icons-react";

export function QrCredentialInput({
  value,
  onChange,
  onFile,
  onEnter,
  disabled = false,
  loading = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onFile: (file: File) => void;
  onEnter?: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <Group gap="xs" wrap="nowrap">
      <PasswordInput
        placeholder="粘贴二维码字符串"
        leftSection={<IconQrcode size={16} />}
        autoComplete="off"
        value={value}
        disabled={disabled || loading}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && value.trim() && onEnter) {
            onEnter();
          }
        }}
        style={{ flex: 1 }}
      />
      <FileButton
        accept="image/png,image/jpeg,image/webp"
        onChange={(file) => {
          if (file) {
            onFile(file);
          }
        }}
      >
        {(props) => (
          <Button
            {...props}
            variant="light"
            leftSection={<IconUpload size={16} />}
            disabled={disabled || loading}
            loading={loading}
            style={{ flexShrink: 0 }}
          >
            上传图片
          </Button>
        )}
      </FileButton>
    </Group>
  );
}
