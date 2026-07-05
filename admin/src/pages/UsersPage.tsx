import { Button, Card, Tag, Typography } from "antd";
import { ReloadOutlined, TeamOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageHeader } from "../components/PageHeader";
import { ResponsiveTable } from "../components/ResponsiveTable";
import { adminHeaders, createAdminApi } from "../api/client";
import {
  type AdminUser,
  formatDateTime,
  useAdminContext,
} from "../utils/admin";

const { Text } = Typography;

export default function UsersPage() {
  const { password, environment } = useAdminContext();
  const adminApi = useMemo(() => createAdminApi(environment), [environment]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    try {
      const res = await adminApi.getAllUsers({
        headers: adminHeaders(password),
      });
      if (res.status === 200) {
        setUsers((res.body as AdminUser[]) ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [adminApi, password]);

  useEffect(() => {
    if (password && users.length === 0) {
      void load();
    }
  }, [password, users.length, load]);

  const columns = useMemo(
    () => [
      {
        title: "好友码",
        dataIndex: "friendCode",
        key: "friendCode",
        width: 180,
        render: (value: string) => (
          <Text className="cell-monospace">{value}</Text>
        ),
      },
      {
        title: "用户名",
        dataIndex: "username",
        key: "username",
        width: 220,
        render: (value: string | null) => value ?? "-",
      },
      {
        title: "Rating",
        dataIndex: "rating",
        key: "rating",
        width: 120,
        render: (value: number | null) =>
          value === null ? "-" : <Tag color="blue">{value}</Tag>,
      },
      {
        title: "注册时间",
        dataIndex: "createdAt",
        key: "createdAt",
        width: 220,
        render: (value: string) => formatDateTime(value),
      },
    ],
    [],
  );

  return (
    <div className="page-stack">
      <PageHeader
        title="用户列表"
        description={`当前共 ${users.length} 个用户。`}
        extra={
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => void load()}
            loading={loading}
          >
            刷新
          </Button>
        }
      />

      <Card
        className="admin-card wide-table-card"
        title={
          <>
            <TeamOutlined /> 用户
          </>
        }
      >
        <ResponsiveTable
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={users}
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          renderMobileItem={(user) => (
            <div className="mobile-fields">
              <Text strong className="mobile-card-title">
                {user.username ?? user.friendCode}
              </Text>
              <div className="mobile-field">
                <Text type="secondary">好友码</Text>
                <Text className="cell-monospace">{user.friendCode}</Text>
              </div>
              <div className="mobile-field">
                <Text type="secondary">Rating</Text>
                <span>{user.rating === null ? "-" : <Tag color="blue">{user.rating}</Tag>}</span>
              </div>
              <div className="mobile-field">
                <Text type="secondary">注册时间</Text>
                <span>{formatDateTime(user.createdAt)}</span>
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
