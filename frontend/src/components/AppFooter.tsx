import { Anchor, Box, Group, Text } from "@mantine/core";
import { Link } from "react-router-dom";

export function AppFooter() {

    return (
        <Box
            component="footer"
            py="md"
            px="md"
            style={{
                marginTop: "auto",
            }}
        >
            <Group justify="center" gap="xs">
                <Text size="sm" >
                    Made by{" "}
                    <Text span fw={600}>
                        Bakapiano
                    </Text>
                </Text>
                <Text size="sm" >
                    ·
                </Text>
                <Anchor component={Link} to="/about" size="sm">
                    关于
                </Anchor>
            </Group>
        </Box>
    );
}
