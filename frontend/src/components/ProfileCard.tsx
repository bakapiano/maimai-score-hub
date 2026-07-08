import {
  Badge,
  Box,
  Card,
  Divider,
  Group,
  Image,
  Stack,
  Text,
} from "@mantine/core";
import { normalizeMaimaiImgUrl } from "../utils/maimaiImages";
import classes from "./ProfileCard.module.css";

export type UserProfile = {
  avatarUrl: string | null;
  title: string | null;
  titleColor: string | null;
  username: string | null;
  rating: number | null;
  ratingBgUrl: string | null;
  courseRankUrl: string | null;
  classRankUrl: string | null;
  awakeningCount: number | null;
};

type Props = {
  profile: UserProfile;
};

const AVATAR_PLACEHOLDER = "/avatar-placeholder.svg";

function getTrophyColor(color: string | null) {
  const normalized = color?.trim().toLowerCase();
  if (!normalized) {return "#656a7e";}
  if (normalized.startsWith("#") || normalized.startsWith("rgb")) {
    return color ?? "#656a7e";
  }
  if (normalized === "bronze" || normalized === "copper") {return "#f06418";}
  if (normalized === "gold") {return "#ffab09";}
  if (normalized === "platina") {return "#d9d02f";}
  if (normalized === "silver") {return "#09b8ff";}
  if (normalized === "normal") {return "#656a7e";}
  return "#8931b2";
}

function hexToRgba(hex: string, alpha: number) {
  if (hex.startsWith("rgb")) {
    return hex.replace("rgb(", "rgba(").replace(")", `, ${alpha})`);
  }
  const value = hex.replace("#", "");
  if (value.length !== 6) {return `rgba(101, 106, 126, ${alpha})`;}
  const int = parseInt(value, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getDeluxeRatingGradient(rating: number) {
  if (rating < 1000) {return { from: "#9bdcf7", to: "#9bdcf7" };}
  if (rating < 2000) {return { from: "#4ea3ff", to: "#2364d2" };}
  if (rating < 4000) {return { from: "#b7e84f", to: "#2f9e44" };}
  if (rating < 7000) {return { from: "#ffe066", to: "#f08c00" };}
  if (rating < 10000) {return { from: "#ff8787", to: "#e03131" };}
  if (rating < 12000) {return { from: "#da77f2", to: "#862e9c" };}
  if (rating < 13000) {return { from: "#c08457", to: "#7c4a2d" };}
  if (rating < 14000) {return { from: "#9bdcf7", to: "#2364d2" };}
  if (rating < 14500) {return { from: "#ffd43b", to: "#f08c00" };}
  if (rating < 15000) {return { from: "#fff3bf", to: "#fab005" };}
  return { from: "#ae3ec9", to: "#15aabf" };
}

export function ProfileCard({ profile }: Props) {
  const trophyColor = getTrophyColor(profile.titleColor);
  const avatarSrc = profile.avatarUrl
    ? normalizeMaimaiImgUrl(profile.avatarUrl)
    : AVATAR_PLACEHOLDER;

  return (
    <Card withBorder shadow="xs" padding={0} radius="md">
      <Box className={classes.scrollArea}>
        <Group
          className={classes.profileBody}
          align="center"
          gap="md"
          wrap="nowrap"
        >
          <Box className={classes.avatarFrame}>
            <Image
              src={avatarSrc}
            alt={profile.username ?? "avatar"}
            w="100%"
            h="100%"
            fit="contain"
            referrerPolicy="no-referrer"
              fallbackSrc={AVATAR_PLACEHOLDER}
            />
          </Box>

          <Stack
            className={classes.summary}
            gap={0}
          >
            <Group
              className={classes.metaRow}
              gap="xs"
              mb={8}
              wrap="nowrap"
              align="center"
            >
              {profile.title && (
                <Badge
                  className={classes.titleBadge}
                  size="md"
                  radius={10}
                  style={{
                    background: hexToRgba(trophyColor, 0.13),
                    color: trophyColor,
                  }}
                >
                  {profile.title}
                </Badge>
              )}
              {profile.rating !== null && (
                <Badge
                  className={classes.ratingBadge}
                  size="md"
                  variant="gradient"
                  gradient={getDeluxeRatingGradient(profile.rating)}
                >
                  DX 评分: {profile.rating}
                </Badge>
              )}
            </Group>

            <Text
              fw={500}
              size="lg"
              lineClamp={1}
              style={{
                minWidth: 0,
                lineHeight: 1.2,
              }}
            >
              {profile.username ?? "未知用户"}
            </Text>

            <Divider mt={0} variant="dashed" />

            <Group className={classes.rankRow} h={40} gap="xs" wrap="nowrap">
              {profile.courseRankUrl && (
                <Image
                  className={classes.courseRank}
                src={normalizeMaimaiImgUrl(profile.courseRankUrl)}
                alt="course rank"
                fit="contain"
                referrerPolicy="no-referrer"
              />
              )}
              {profile.classRankUrl && (
                <Box className={classes.classRankFrame}>
                  <Image
                  src={normalizeMaimaiImgUrl(profile.classRankUrl)}
                  alt="class rank"
                  h={36}
                  w="auto"
                  fit="contain"
                  referrerPolicy="no-referrer"
                />
                </Box>
              )}
              {profile.awakeningCount !== null && (
                <Group
                className={classes.starGroup}
                gap={2}
                wrap="nowrap"
              >
                <Image
                  className={classes.starIcon}
                  src="/maimai-mobile/img/icon_star.png"
                  alt="star"
                  fit="contain"
                  referrerPolicy="no-referrer"
                />
                  <Text size="sm">
                    ×{profile.awakeningCount}
                  </Text>
                </Group>
              )}
            </Group>
          </Stack>
        </Group>
      </Box>
    </Card>
  );
}
