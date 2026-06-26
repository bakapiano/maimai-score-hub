# ADB Worker - Bot Cookie 自动恢复服务

通过 ADB + Chrome DevTools Protocol (CDP) 控制 Android 设备上的微信 WebView，在 Bot 掉线时自动打开恢复 URL 重新获取 Cookie。

## 功能

- 自动发现并管理 ADB 设备（USB / WiFi）
- 定期轮询后端 Bot 状态，检测掉线
- 掉线时自动通过 CDP 在微信 WebView 中导航到恢复 URL
- 自动处理微信安全拦截页面（点击"继续访问"）
- Web 管理面板（设备管理、绑定管理、Bot 状态、恢复日志、设置）

## 架构

```
┌─────────────┐   轮询 Bot 状态    ┌──────────┐
│  ADB Worker │ ◄────────────────► │ Backend  │
│  (FastAPI)  │                    │ (NestJS) │
└──────┬──────┘                    └──────────┘
       │ ADB + CDP
       ▼
┌─────────────┐
│  Android    │  微信 WebView
│  设备       │  导航到恢复 URL
└─────────────┘
```

## 安装

```bash
cd automation
pip install -r requirements.txt
```

## 启动

```bash
python app.py
```

启动后访问 `http://localhost:8080` 打开管理面板。

## 配置

### 启动参数（环境变量）

| 变量       | 默认值            | 说明               |
| ---------- | ----------------- | ------------------ |
| `HOST`     | `0.0.0.0`         | 监听地址           |
| `PORT`     | `8080`            | 监听端口           |
| `ADB_PATH` | 自动检测          | ADB 可执行文件路径 |
| `DB_PATH`  | `./adb_worker.db` | SQLite 数据库路径  |

### 运行时配置（Web 面板「设置」页）

| 项目         | 默认值                                  | 说明                                                    |
| ------------ | --------------------------------------- | ------------------------------------------------------- |
| Backend URL  | `https://api.maiscorehub.bakapiano.com` | 后端 API 地址                                           |
| API 共享密钥 | 空                                      | 用于调用 `/api/v1/admin/bots`，通过 `X-API-Secret` 发送 |
| 轮询间隔     | `30` 秒                                 | Bot 状态检查 + 自动恢复间隔                             |
| 设备扫描间隔 | `10` 秒                                 | ADB 设备扫描间隔                                        |

运行时配置保存在 SQLite 中，修改后立即生效，无需重启。

## 使用流程

1. 启动服务，打开 `http://localhost:8080`
2. 在「设置」页填写 Backend URL 和 API 共享密钥
3. 在「设备」页配对/连接 Android 设备
4. 在「绑定」页将设备与 Bot 好友码关联，填写恢复 URL
5. 服务会自动监控 Bot 状态，掉线时自动恢复

## 前置条件

- Android 设备已开启 **USB 调试** 或 **无线调试**
- 微信已登录且 WebView 可用
- Python 3.10+

## 项目结构

```
automation/
├── app.py              # FastAPI 主应用 + 后台任务
├── config.py           # 启动参数配置
├── db.py               # SQLite 数据库管理
├── models.py           # 数据模型
├── requirements.txt    # Python 依赖
├── services/
│   ├── adb_service.py  # ADB 设备管理
│   ├── bot_monitor.py  # Bot 状态监控
│   ├── cdp_service.py  # CDP WebView 控制
│   └── recovery.py     # Cookie 恢复编排
└── static/
    └── index.html      # Web 管理面板
```

- 首次运行可能需要在手机上确认安装 atx-agent
