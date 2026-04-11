#!/bin/bash
set -e

APP_DIR=/opt/automation

echo "=== ADB Worker 部署脚本 ==="

# 1. 检查 Python 版本
echo "[1/5] 检查 Python..."
if ! command -v python3 &> /dev/null; then
    echo "未找到 python3，正在安装..."
    sudo apt update
    sudo apt install -y python3 python3-pip python3-venv
else
    echo "Python3: $(python3 --version)"
fi

# 2. 复制项目文件
echo "[2/5] 复制项目文件到 $APP_DIR ..."
sudo mkdir -p "$APP_DIR"
sudo cp app.py config.py db.py models.py requirements.txt adb-worker.service "$APP_DIR/"
sudo cp -r services "$APP_DIR/"
sudo cp -r static "$APP_DIR/"
sudo cp -r resources "$APP_DIR/" 2>/dev/null || true

# 3. 创建虚拟环境并安装依赖
echo "[3/5] 创建虚拟环境并安装依赖..."
cd "$APP_DIR"
sudo python3 -m venv venv
sudo "$APP_DIR/venv/bin/pip" install --upgrade pip
sudo "$APP_DIR/venv/bin/pip" install -r requirements.txt

# 4. 安装 systemd 服务
echo "[4/5] 配置 systemd 服务..."
sudo cp "$APP_DIR/adb-worker.service" /etc/systemd/system/adb-worker.service 2>/dev/null \
    || sudo cp "$(dirname "$0")/adb-worker.service" /etc/systemd/system/adb-worker.service
sudo systemctl daemon-reload
sudo systemctl enable adb-worker

# 5. 启动服务
echo "[5/5] 启动服务..."
sudo systemctl restart adb-worker

echo ""
echo "=== 部署完成 ==="
echo "服务状态: sudo systemctl status adb-worker"
echo "查看日志: sudo journalctl -u adb-worker -f"
echo "管理面板: http://<服务器IP>:8080"
