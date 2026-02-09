import {
  Button,
  Card,
  Group,
  Pagination,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { IconRefresh, IconUsers } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { adminFetch, useAdminContext, type AdminUser } from "./adminUtils";

export default function AdminUsersPage() {
  const { password } = useAdminContext();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const perPage = 20;

  const paginatedUsers = useMemo(() => {
    const start = (page - 1) * perPage;
    return users.slice(start, start + perPage);
  }, [users, page]);

  const totalPages = useMemo(
    () => Math.ceil(users.length / perPage),
    [users.length],
  );

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    const res = await adminFetch<AdminUser[]>("/api/admin/users", password);
    setLoading(false);
    if (res.ok && res.data) {
      setUsers(res.data);
      setPage(1);
    }
  }, [password]);

  useEffect(() => {
    if (password && users.length === 0) {
      void load();
    }
  }, [password, users.length, load]);

  return (
    <Card withBorder shadow="sm" padding="lg" radius="md">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Group gap="xs">
            <IconUsers size={20} />
            <Text fw={600}>用户列表 ({users.length})</Text>
          </Group>
          <Button
            variant="light"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            onClick={load}
            loading={loading}
          >
            刷新
          </Button>
        </Group>

        {users.length > 0 ? (
          <>
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>好友码</Table.Th>
                  <Table.Th>用户名</Table.Th>
                  <Table.Th>Rating</Table.Th>
                  <Table.Th>注册时间</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {paginatedUsers.map((user) => (
                  <Table.Tr key={user.id}>
                    <Table.Td>
                      <Text size="sm" ff="monospace">
                        {user.friendCode}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{user.username ?? "-"}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{user.rating ?? "-"}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {new Date(user.createdAt).toLocaleString("zh-CN", {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>

            {totalPages > 1 && (
              <Group justify="center">
                <Pagination
                  total={totalPages}
                  value={page}
                  onChange={setPage}
                  size="sm"
                />
              </Group>
            )}
          </>
        ) : (
          <Text size="sm" c="dimmed" ta="center">
            {loading ? "加载中..." : "暂无用户数据"}
          </Text>
        )}
      </Stack>
    </Card>
  );
}
