import { Badge, Box, Card, Group, Image, Stack, Text } from "@mantine/core";

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

export function ProfileCard({ profile }: Props) {
  return (
    <Card withBorder shadow="xs" padding="sm">
      <Group align="flex-start" gap="md" wrap="nowrap">
        {profile.avatarUrl && (
          <Card shadow="xs" padding={4} radius="md" style={{ flexShrink: 0 }}>
            <Image
              src={profile.avatarUrl}
              alt={profile.username ?? "avatar"}
              width={128}
              height={128}
            />
          </Card>
        )}

        <Stack
          gap={6}
          style={{
            flex: 1,
            minWidth: 0,
            height: 128,
            overflow: "visible",
          }}
        >
          {/* Row 1: Title chip; height = 1/3 */}
          <Box
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              width: "100%",
              minHeight: 0,
              padding: "0 10px",
            }}
          >
            {profile.title && (
              <Badge
                size="md"
                variant="filled"
                style={{
                  width: "100%",
                  textTransform: "none",
                }}
              >
                {profile.title}
              </Badge>
            )}
          </Box>

          {/* Row 2: Username + Rating; height = 1/3 */}
          <Box
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              minHeight: 0,
              overflow: "visible",
            }}
          >
            <Text
              fw={700}
              size="lg"
              style={{
                minWidth: 160,
                padding: "6px 10px",
              }}
            >
              {profile.username ?? "未知用户"}
            </Text>

            {profile.rating !== null && (
              <Badge size="md" variant="filled" color="orange">
                {profile.rating}
              </Badge>
            )}
          </Box>

          {/* Row 3: badges and star; height = 1/3 */}
          <Box
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              gap: 6,
              minHeight: 0,
              overflow: "visible",
            }}
          >
            {profile.courseRankUrl && (
              <Image
                src={profile.courseRankUrl}
                alt="course rank"
                style={{ height: "100%", width: "auto" }}
                fit="contain"
              />
            )}
            {profile.classRankUrl && (
              <Image
                src={profile.classRankUrl}
                alt="class rank"
                style={{ height: "100%", width: "auto" }}
                fit="contain"
              />
            )}
            {profile.awakeningCount !== null && (
              <Box
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  whiteSpace: "nowrap",
                }}
              >
                <Image
                  src="https://maimai.wahlap.com/maimai-mobile/img/icon_star.png"
                  alt="star"
                  width={22}
                  height={22}
                  fit="contain"
                />
                <Text size="sm" fw={700}>
                  ×{profile.awakeningCount}
                </Text>
              </Box>
            )}
          </Box>
        </Stack>
      </Group>
    </Card>
  );
}
