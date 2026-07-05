import {
  Button,
  Card,
  Col,
  Row,
  Space,
  Typography,
  message,
} from "antd";
import {
  CloudSyncOutlined,
  DatabaseOutlined,
  PictureOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useCallback, useMemo, useState } from "react";

import { PageHeader } from "../components/PageHeader";
import { adminHeaders, createAdminApi, createCoverApi } from "../api/client";
import { useAdminContext } from "../utils/admin";

const { Paragraph, Text } = Typography;

export default function SyncPage() {
  const { password, environment } = useAdminContext();
  const adminApi = useMemo(() => createAdminApi(environment), [environment]);
  const coverApi = useMemo(() => createCoverApi(environment), [environment]);
  const [coverSyncing, setCoverSyncing] = useState(false);
  const [coverSyncResult, setCoverSyncResult] = useState("");
  const [coverForceSyncing, setCoverForceSyncing] = useState(false);
  const [coverForceSyncResult, setCoverForceSyncResult] = useState("");
  const [coverBackfilling, setCoverBackfilling] = useState(false);
  const [coverBackfillResult, setCoverBackfillResult] = useState("");
  const [musicSyncing, setMusicSyncing] = useState(false);
  const [musicSyncResult, setMusicSyncResult] = useState("");

  const syncCovers = useCallback(async () => {
    if (!password) return;
    setCoverSyncing(true);
    setCoverSyncResult("");
    const res = await adminApi.syncCovers({
      headers: adminHeaders(password),
    });
    setCoverSyncing(false);
    if (res.status === 201) {
      const text = `完成: 总计 ${res.body.total}, 保存 ${res.body.saved}, 跳过 ${res.body.skipped}, 失败 ${res.body.failed}`;
      setCoverSyncResult(text);
      message.success("封面同步完成");
    } else {
      setCoverSyncResult(`失败: HTTP ${res.status}`);
    }
  }, [adminApi, password]);

  const forceSyncCovers = useCallback(async () => {
    if (!password) return;
    setCoverForceSyncing(true);
    setCoverForceSyncResult("");
    const res = await adminApi.forceSyncCovers({
      headers: adminHeaders(password),
    });
    setCoverForceSyncing(false);
    if (res.status === 201) {
      const text = `完成: 总计 ${res.body.total}, 保存 ${res.body.saved}, 跳过 ${res.body.skipped}, 失败 ${res.body.failed}`;
      setCoverForceSyncResult(text);
      message.success("封面强制同步完成");
    } else {
      setCoverForceSyncResult(`失败: HTTP ${res.status}`);
    }
  }, [adminApi, password]);

  const backfillCoverVariants = useCallback(async () => {
    if (!password) return;
    setCoverBackfilling(true);
    setCoverBackfillResult("");
    const res = await coverApi.backfillVariants({
      headers: adminHeaders(password),
    });
    setCoverBackfilling(false);
    if (res.status === 201) {
      const text = `补齐完成: 总计 ${res.body.total}, 新增 ${res.body.saved}, 跳过 ${res.body.skipped}, 失败 ${res.body.failed}`;
      setCoverBackfillResult(text);
      message.success("封面格式补齐完成");
    } else {
      setCoverBackfillResult(`补齐失败: HTTP ${res.status}`);
    }
  }, [coverApi, password]);

  const syncMusic = useCallback(async () => {
    if (!password) return;
    setMusicSyncing(true);
    setMusicSyncResult("");
    const res = await adminApi.syncMusic({
      headers: adminHeaders(password),
    });
    setMusicSyncing(false);
    if (res.status === 201) {
      const text = `完成: 总计 ${res.body.total}, 新增 ${res.body.added}, 更新 ${res.body.updated}`;
      setMusicSyncResult(text);
      message.success("歌曲数据同步完成");
    } else {
      setMusicSyncResult(`失败: HTTP ${res.status}`);
    }
  }, [adminApi, password]);

  return (
    <div className="page-stack">
      <PageHeader
        title="数据同步"
        description="触发曲目、封面和封面格式补齐任务。"
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            className="admin-card"
            title={
              <Space>
                <PictureOutlined />
                封面数据
              </Space>
            }
          >
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <Space wrap>
                <Button
                  type="primary"
                  icon={<CloudSyncOutlined />}
                  onClick={syncCovers}
                  loading={coverSyncing}
                >
                  同步封面
                </Button>
                <Button
                  icon={<ReloadOutlined />}
                  onClick={forceSyncCovers}
                  loading={coverForceSyncing}
                >
                  强制重新同步封面
                </Button>
                <Button
                  icon={<DatabaseOutlined />}
                  onClick={backfillCoverVariants}
                  loading={coverBackfilling}
                >
                  补齐封面格式
                </Button>
              </Space>
              {coverSyncResult ? <Paragraph>{coverSyncResult}</Paragraph> : null}
              {coverForceSyncResult ? (
                <Paragraph>{coverForceSyncResult}</Paragraph>
              ) : null}
              {coverBackfillResult ? (
                <Paragraph>{coverBackfillResult}</Paragraph>
              ) : null}
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card
            className="admin-card"
            title={
              <Space>
                <DatabaseOutlined />
                歌曲数据
              </Space>
            }
          >
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <Button
                type="primary"
                icon={<CloudSyncOutlined />}
                onClick={syncMusic}
                loading={musicSyncing}
              >
                同步歌曲数据（Diving-Fish）
              </Button>
              {musicSyncResult ? <Text>{musicSyncResult}</Text> : null}
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
