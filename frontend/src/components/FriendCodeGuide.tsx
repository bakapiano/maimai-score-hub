import { Anchor, Collapse, Image, Stack, Text } from "@mantine/core";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";

export function FriendCodeGuide() {
  const [opened, { toggle }] = useDisclosure(false);

  return (
    <Stack gap={4}>
      <Anchor
        component="button"
        type="button"
        size="md"
        fw={500}
        onClick={toggle}
        style={{
          alignSelf: "flex-start",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {opened ? <IconChevronUp size={20} /> : <IconChevronDown size={20} />}
        好友代码是什么？
      </Anchor>
      <Collapse in={opened}>
        <Stack gap="xs">
          <Text size="sm">
            登录{" "}
            <Anchor
              href="https://tgk-wcaime.wahlap.com/wc_auth/oauth/authorize/maimai-dx"
              target="_blank"
              rel="noopener"
            >
              maimai NET
            </Anchor>
            ，进入「好友」页面，点击右下角「你的好友号码」即可查看。
          </Text>
          <Image
            src="/friendcode.png"
            alt="好友代码查找教程"
            radius="md"
            w="100%"
          />
        </Stack>
      </Collapse>
    </Stack>
  );
}
