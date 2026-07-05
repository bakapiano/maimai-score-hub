import { App as AntdApp, ConfigProvider, Spin, theme } from "antd";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Suspense, lazy } from "react";

const AdminLayout = lazy(() => import("./layout/AdminLayout"));
const RealtimePage = lazy(() => import("./pages/RealtimePage"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const SyncPage = lazy(() => import("./pages/SyncPage"));
const JobDebugPage = lazy(() => import("./pages/JobDebugPage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const WorkerLogsPage = lazy(() => import("./pages/WorkerLogsPage"));

function PageLoader() {
  return (
    <div className="page-loader">
      <Spin size="large" />
    </div>
  );
}

export default function App() {
  const systemSans =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#1677ff",
          borderRadius: 8,
          fontFamily: systemSans,
        },
        components: {
          Card: {
            headerBg: "#ffffff",
          },
          Layout: {
            bodyBg: "#f5f7fb",
            headerBg: "#ffffff",
            siderBg: "#101828",
          },
          Menu: {
            darkItemBg: "#101828",
            darkSubMenuItemBg: "#101828",
            darkItemSelectedBg: "#1677ff",
          },
          Table: {
            headerBg: "#f8fafc",
            rowHoverBg: "#f5f9ff",
          },
        },
      }}
    >
      <AntdApp>
        <BrowserRouter>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<Navigate to="/admin" replace />} />
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<RealtimePage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="sync" element={<SyncPage />} />
                <Route path="job-debug" element={<JobDebugPage />} />
                <Route path="users" element={<UsersPage />} />
                <Route path="live-logs" element={<WorkerLogsPage />} />
                <Route
                  path="history/logs"
                  element={<Navigate to="/admin/live-logs" replace />}
                />
              </Route>
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  );
}
