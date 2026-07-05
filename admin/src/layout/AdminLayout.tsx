import {
  BugOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  LogoutOutlined,
  MenuOutlined,
  OrderedListOutlined,
  ReloadOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Form,
  Grid,
  Input,
  Layout,
  Menu,
  Select,
  Space,
  Typography,
} from "antd";
import type { ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useMemo, useState } from "react";

import { adminHeaders, createAdminApi, getApiBaseUrl } from "../api/client";
import {
  type AdminEnvironment,
  type HistoryWindow,
  type LogWindow,
  type RealtimeWindow,
  getDefaultAdminEnvironment,
  useApiSharedSecret,
} from "../utils/admin";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const { Content, Header, Sider } = Layout;
const { Password } = Input;
const { Text, Title } = Typography;
const { useBreakpoint } = Grid;

const ADMIN_ENVIRONMENT_KEY = "admin_environment";
const ADMIN_REALTIME_WINDOW_KEY = "admin_realtime_window";
const ADMIN_HISTORY_WINDOW_KEY = "admin_history_window";
const ADMIN_LOG_WINDOW_KEY = "admin_log_window";

const realtimeWindowOptions: Array<{ value: RealtimeWindow; label: string }> = [
  { value: "15m", label: "近 15 分钟" },
  { value: "1h", label: "近 1 小时" },
  { value: "6h", label: "近 6 小时" },
  { value: "24h", label: "近 24 小时" },
];

const historyWindowOptions: Array<{ value: HistoryWindow; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

const logWindowOptions: Array<{ value: LogWindow; label: string }> = [
  { value: "5", label: "近 5 分钟" },
  { value: "15", label: "近 15 分钟" },
  { value: "60", label: "近 1 小时" },
  { value: "360", label: "近 6 小时" },
  { value: "1440", label: "近 24 小时" },
];

type AdminPageMeta = {
  key: string;
  label: string;
  to: string;
  icon: ReactNode;
};

const adminPages: AdminPageMeta[] = [
  {
    key: "/admin",
    label: "实时监控",
    to: "/admin",
    icon: <ClockCircleOutlined />,
  },
  {
    key: "/admin/history",
    label: "历史分析",
    to: "/admin/history",
    icon: <OrderedListOutlined />,
  },
  {
    key: "/admin/sync",
    label: "数据同步",
    to: "/admin/sync",
    icon: <DatabaseOutlined />,
  },
  {
    key: "/admin/job-debug",
    label: "任务调试",
    to: "/admin/job-debug",
    icon: <BugOutlined />,
  },
  {
    key: "/admin/users",
    label: "用户列表",
    to: "/admin/users",
    icon: <TeamOutlined />,
  },
  {
    key: "/admin/live-logs",
    label: "实时日志流",
    to: "/admin/live-logs",
    icon: <ReloadOutlined />,
  },
];

export default function AdminLayout() {
  const { message } = App.useApp();
  const { password, savePassword } = useApiSharedSecret();
  const [inputPassword, setInputPassword] = useState(password);
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [environment, setEnvironment] = useState<AdminEnvironment>(() =>
    readStorageEnum<AdminEnvironment>(
      ADMIN_ENVIRONMENT_KEY,
      ["dev", "prod"],
      getDefaultAdminEnvironment(),
    ),
  );
  const [realtimeWindow, setRealtimeWindow] = useState<RealtimeWindow>(() =>
    readStorageEnum<RealtimeWindow>(
      ADMIN_REALTIME_WINDOW_KEY,
      ["15m", "1h", "6h", "24h"],
      "1h",
    ),
  );
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>(() =>
    readStorageEnum<HistoryWindow>(
      ADMIN_HISTORY_WINDOW_KEY,
      ["24h", "7d", "30d"],
      "24h",
    ),
  );
  const [logWindow, setLogWindow] = useState<LogWindow>(() =>
    readStorageEnum<LogWindow>(
      ADMIN_LOG_WINDOW_KEY,
      ["5", "15", "60", "360", "1440"],
      "15",
    ),
  );
  const location = useLocation();
  const navigate = useNavigate();
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const adminApi = useMemo(() => createAdminApi(environment), [environment]);

  const selectedKey = useMemo(() => {
    const exact = adminPages.find((page) => page.to === location.pathname);
    return exact?.key ?? "/admin";
  }, [location.pathname]);

  const currentPage = adminPages.find((page) => page.key === selectedKey);
  useDocumentTitle(currentPage?.label ?? "管理后台");

  useEffect(() => {
    writeStorage(ADMIN_ENVIRONMENT_KEY, environment);
  }, [environment]);

  useEffect(() => {
    writeStorage(ADMIN_REALTIME_WINDOW_KEY, realtimeWindow);
  }, [realtimeWindow]);

  useEffect(() => {
    writeStorage(ADMIN_HISTORY_WINDOW_KEY, historyWindow);
  }, [historyWindow]);

  useEffect(() => {
    writeStorage(ADMIN_LOG_WINDOW_KEY, logWindow);
  }, [logWindow]);

  const verifyPassword = useCallback(
    async (candidate: string) => {
      const trimmed = candidate.trim();
      if (!trimmed) {
        setError("请输入 API 共享密钥");
        return;
      }

      setVerifying(true);
      setError("");
      try {
        const res = await adminApi.getStats({
          headers: adminHeaders(trimmed),
        });
        if (res.status === 200) {
          savePassword(trimmed);
          setVerified(true);
          message.success("已进入管理后台");
        } else {
          setError(`验证失败 (HTTP ${res.status})`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "验证失败");
      } finally {
        setVerifying(false);
      }
    },
    [adminApi, message, savePassword],
  );

  useEffect(() => {
    if (!password || verified) return;
    setInputPassword(password);
    void verifyPassword(password);
  }, [password, verified, verifyPassword]);

  const menuItems = adminPages.map((page) => ({
    key: page.key,
    icon: page.icon,
    label: (
      <Link to={page.to} onClick={() => setDrawerOpen(false)}>
        {page.label}
      </Link>
    ),
  }));

  const timeControl =
    selectedKey === "/admin" ? (
      <Select<RealtimeWindow>
        aria-label="实时窗口"
        value={realtimeWindow}
        onChange={setRealtimeWindow}
        options={realtimeWindowOptions}
        className="admin-header-select"
      />
    ) : selectedKey === "/admin/history" ? (
      <Select<HistoryWindow>
        aria-label="历史窗口"
        value={historyWindow}
        onChange={setHistoryWindow}
        options={historyWindowOptions}
        className="admin-header-select"
      />
    ) : selectedKey === "/admin/live-logs" ? (
      <Select<LogWindow>
        aria-label="日志窗口"
        value={logWindow}
        onChange={setLogWindow}
        options={logWindowOptions}
        className="admin-header-select"
      />
    ) : null;

  if (!verified) {
    return (
      <main className="login-shell">
        <Card className="login-card" variant="borderless">
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <div className="login-card-head">
              <div>
                <Title level={3} style={{ marginBottom: 4 }}>
                  管理入口
                </Title>
                <Text type="secondary">输入 API 共享密钥后进入独立后台。</Text>
              </div>
              <Select<AdminEnvironment>
                aria-label="API 环境"
                value={environment}
                onChange={setEnvironment}
                options={[
                  { value: "dev", label: "dev" },
                  { value: "prod", label: "prod" },
                ]}
                className="admin-header-env-select"
              />
            </div>
            {error ? <Alert type="error" showIcon message={error} /> : null}
            <Form
              layout="vertical"
              onFinish={() => void verifyPassword(inputPassword)}
            >
              <Form.Item label="API 共享密钥" required>
                <Password
                  autoFocus
                  value={inputPassword}
                  onChange={(event) => setInputPassword(event.target.value)}
                  placeholder="输入 API 共享密钥"
                />
              </Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                block
                loading={verifying}
              >
                登录
              </Button>
            </Form>
          </Space>
        </Card>
      </main>
    );
  }

  const sidebar = (
    <>
      <div className="admin-brand">
        <div className="admin-brand-mark">M</div>
        <div className="admin-brand-text">
          <div className="admin-brand-title">Score Hub</div>
          <div className="admin-brand-subtitle">Admin Console</div>
        </div>
      </div>
      <Menu
        theme="dark"
        mode="inline"
        selectedKeys={[selectedKey]}
        items={menuItems}
      />
    </>
  );

  return (
    <Layout className="admin-layout">
      {!isMobile ? (
        <Sider width={232} className="admin-sider">
          {sidebar}
        </Sider>
      ) : (
        <Drawer
          placement="left"
          width={288}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          styles={{ body: { padding: 0, background: "#101828" } }}
        >
          {sidebar}
        </Drawer>
      )}

      <Layout>
        <Header className="admin-header">
          <Space className="admin-header-left">
            {isMobile ? (
              <Button
                icon={<MenuOutlined />}
                onClick={() => setDrawerOpen(true)}
              />
            ) : null}
            <Text strong>{currentPage?.label ?? "管理后台"}</Text>
          </Space>
          <Space className="admin-header-actions" wrap>
            <Select<AdminEnvironment>
              aria-label="API 环境"
              value={environment}
              onChange={setEnvironment}
              options={[
                { value: "dev", label: "dev" },
                { value: "prod", label: "prod" },
              ]}
              className="admin-header-env-select"
            />
            {timeControl}
            <Text type="secondary" className="admin-api-base">
              {getApiBaseUrl(environment)}
            </Text>
            <Button
              icon={<LogoutOutlined />}
              onClick={() => {
                savePassword("");
                setVerified(false);
                setInputPassword("");
                navigate("/admin");
              }}
            >
              退出
            </Button>
          </Space>
        </Header>
        <Content className="admin-content">
          <Outlet
            context={{ password, environment, realtimeWindow, historyWindow, logWindow }}
          />
        </Content>
      </Layout>
    </Layout>
  );
}

function readStorageEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
) {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in private mode.
  }
}
