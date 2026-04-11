"""
ADB 设备管理服务
负责设备发现、配对、连接、信息获取
"""

import asyncio
import logging
import re
from datetime import datetime, timezone
from typing import Optional

from config import config
from models import Device
import db

logger = logging.getLogger("adb_service")


async def _run_adb(*args: str, device: str = None, timeout: int = 15) -> tuple[int, str, str]:
    """执行 adb 命令并返回 (returncode, stdout, stderr)"""
    cmd = [config.ADB_PATH]
    if device:
        cmd.extend(["-s", device])
    cmd.extend(args)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")
    except asyncio.TimeoutError:
        proc.kill()
        return -1, "", "timeout"
    except Exception as e:
        return -1, "", str(e)


async def _get_hardware_id(serial: str) -> str:
    """获取设备硬件序列号作为稳定标识符"""
    code, stdout, _ = await _run_adb("shell", "getprop ro.serialno", device=serial, timeout=5)
    if code == 0 and stdout.strip():
        return stdout.strip()
    # 部分设备可能用 ro.boot.serialno
    code, stdout, _ = await _run_adb("shell", "getprop ro.boot.serialno", device=serial, timeout=5)
    if code == 0 and stdout.strip():
        return stdout.strip()
    return ""


async def list_devices() -> list[Device]:
    """列出所有已连接的 ADB 设备，并同步到数据库"""
    # 先尝试通过 mDNS 自动连接已配对但未连接的设备
    await auto_connect_mdns()

    code, stdout, stderr = await _run_adb("devices", "-l")
    if code != 0:
        logger.error(f"adb devices failed: {stderr}")
        return []

    devices = []
    online_ids = set()

    for line in stdout.strip().splitlines()[1:]:  # 跳过 "List of devices attached"
        line = line.strip()
        if not line:
            continue

        parts = line.split()
        if len(parts) < 2:
            continue

        serial = parts[0]
        status = parts[1]

        if status != "device":
            continue

        # 跳过 mDNS 服务名条目（如 adb-xxx._adb-tls-connect._tcp）
        if "._adb-tls-connect._tcp" in serial or "._adb-tls-pairing._tcp" in serial:
            continue

        # 解析设备信息
        model = ""
        for part in parts[2:]:
            if part.startswith("model:"):
                model = part.split(":", 1)[1]

        device = Device(
            id=serial,
            name=model or serial,
            model=model,
            status="online",
            last_seen=datetime.now(timezone.utc).isoformat(),
        )

        # 获取硬件序列号作为稳定标识符
        hw_id = await _get_hardware_id(serial)
        if hw_id:
            device.hardware_id = hw_id
            # 检查是否有相同硬件 ID 但不同传输地址的旧记录，如有则迁移
            old_device = await db.get_device_by_hardware_id(hw_id)
            if old_device and old_device.id != serial:
                logger.info(f"Device address changed: {old_device.id} -> {serial} (hw: {hw_id})")
                await db.migrate_device_id(old_device.id, serial)

        devices.append(device)
        online_ids.add(serial)

        await db.upsert_device(device)

    # 标记不在列表中的设备为 offline
    await db.mark_devices_offline(online_ids)

    return devices


async def pair_device(ip: str, port: int, pairing_code: str) -> tuple[bool, str]:
    """配对新设备"""
    addr = f"{ip}:{port}"
    logger.info(f"Pairing device at {addr}")

    proc = await asyncio.create_subprocess_exec(
        config.ADB_PATH, "pair", addr,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=f"{pairing_code}\n".encode()),
            timeout=15,
        )
        output = stdout.decode("utf-8", errors="replace") + stderr.decode("utf-8", errors="replace")

        if proc.returncode == 0 or "Successfully paired" in output:
            logger.info(f"Paired successfully: {output.strip()}")
            return True, output.strip()
        else:
            logger.error(f"Pair failed: {output.strip()}")
            return False, output.strip()
    except asyncio.TimeoutError:
        proc.kill()
        return False, "Pairing timeout"


async def connect_device(ip: str, port: int) -> tuple[bool, str]:
    """连接设备"""
    addr = f"{ip}:{port}"
    code, stdout, stderr = await _run_adb("connect", addr)
    output = stdout + stderr

    if "connected" in output.lower():
        logger.info(f"Connected to {addr}")
        return True, output.strip()
    else:
        logger.error(f"Connect failed: {output.strip()}")
        return False, output.strip()


async def get_device_info(serial: str) -> dict:
    """获取设备详细信息"""
    info = {}

    props = {
        "model": "ro.product.model",
        "brand": "ro.product.brand",
        "sdk": "ro.build.version.sdk",
        "android_version": "ro.build.version.release",
    }

    for key, prop in props.items():
        code, stdout, _ = await _run_adb("shell", f"getprop {prop}", device=serial)
        if code == 0:
            info[key] = stdout.strip()

    return info


async def get_webview_sockets(serial: str, package: str = None) -> list[str]:
    """
    获取设备上的 webview devtools socket 列表。
    如果指定 package，只返回属于该包名进程的 socket。
    """
    code, stdout, _ = await _run_adb(
        "shell", "cat /proc/net/unix", device=serial
    )
    if code != 0:
        return []

    sockets = []
    for match in re.finditer(r"@(webview_devtools_remote_(\d+))", stdout):
        socket_name = match.group(1)
        pid = match.group(2)

        if package:
            # 通过 /proc/<pid>/cmdline 反查进程包名
            rc, cmdline, _ = await _run_adb(
                "shell", f"cat /proc/{pid}/cmdline", device=serial, timeout=5
            )
            if rc != 0:
                continue
            proc_name = cmdline.split("\x00")[0].strip()
            if proc_name != package:
                logger.debug(f"[{serial}] Socket {socket_name} belongs to {proc_name}, skipping")
                continue

        sockets.append(socket_name)
    return sockets


async def ensure_wechat_webview(serial: str) -> bool:
    """确保微信 WebView 在运行，如果没有则触发"""
    sockets = await get_webview_sockets(serial, package="com.tencent.mm")
    if sockets:
        return True

    # 启动微信
    logger.info(f"[{serial}] Starting WeChat...")
    await _run_adb("shell", "am start -n com.tencent.mm/.ui.LauncherUI", device=serial)
    await asyncio.sleep(3)

    # 触发 WebView
    logger.info(f"[{serial}] Triggering WebView via weixin scheme...")
    await _run_adb(
        "shell",
        "am start -a android.intent.action.VIEW -d 'weixin://dl/scan'",
        device=serial,
    )
    await asyncio.sleep(5)

    sockets = await get_webview_sockets(serial, package="com.tencent.mm")
    if sockets:
        logger.info(f"[{serial}] WebView socket found: {sockets[0]}")
        return True

    logger.warning(f"[{serial}] No WebView socket found after trigger")
    return False


async def forward_port(serial: str, local_port: int, socket_name: str) -> bool:
    """设置端口转发"""
    # 先移除旧的
    await _run_adb("forward", "--remove", f"tcp:{local_port}", device=serial)

    code, stdout, stderr = await _run_adb(
        "forward", f"tcp:{local_port}", f"localabstract:{socket_name}",
        device=serial,
    )
    if code == 0:
        logger.info(f"[{serial}] Forwarded tcp:{local_port} -> {socket_name}")
        return True
    else:
        logger.error(f"[{serial}] Forward failed: {stderr}")
        return False


async def remove_forward(local_port: int):
    """移除端口转发"""
    await _run_adb("forward", "--remove", f"tcp:{local_port}")


async def is_device_online(serial: str) -> bool:
    """检查设备是否在线"""
    code, stdout, _ = await _run_adb("get-state", device=serial, timeout=5)
    return code == 0 and "device" in stdout.strip()


async def send_notification(serial: str, title: str = "ADB Worker", message: str = "这是你的设备") -> tuple[bool, str]:
    """向设备发送通知以帮助识别设备"""
    code, stdout, stderr = await _run_adb(
        "shell",
        f'cmd notification post -S bigtext -t "{title}" adb_worker_identify "{message}"',
        device=serial,
    )
    output = (stdout + stderr).strip()
    if code == 0:
        logger.info(f"[{serial}] Notification sent: {title} - {message}")
        return True, "通知已发送"
    else:
        logger.error(f"[{serial}] Notification failed: {output}")
        return False, output


async def get_proxy(serial: str) -> str:
    """获取设备当前的全局 HTTP 代理设置"""
    code, stdout, _ = await _run_adb(
        "shell", "settings get global http_proxy", device=serial, timeout=5
    )
    if code == 0:
        val = stdout.strip()
        if val == "null" or val == ":0" or not val:
            return ""
        return val
    return ""


async def set_proxy(serial: str, proxy: str) -> tuple[bool, str]:
    """
    设置或清除设备的全局 HTTP 代理。
    proxy 为空字符串或 ":0" 时清除代理。
    使用 iptables/redsocks 不现实，改用 settings put global 方式。
    如果权限不足，先尝试授予 WRITE_SECURE_SETTINGS。
    """
    if not proxy or proxy == ":0":
        # 清除代理
        code, stdout, stderr = await _run_adb(
            "shell", "settings put global http_proxy :0", device=serial
        )
        if code != 0 and "SecurityException" in (stdout + stderr):
            # 尝试授权后重试
            await _run_adb(
                "shell", "pm grant com.android.shell android.permission.WRITE_SECURE_SETTINGS",
                device=serial,
            )
            code, stdout, stderr = await _run_adb(
                "shell", "settings put global http_proxy :0", device=serial
            )
        msg = "代理已清除"
    else:
        code, stdout, stderr = await _run_adb(
            "shell", f"settings put global http_proxy {proxy}", device=serial
        )
        if code != 0 and "SecurityException" in (stdout + stderr):
            # 尝试授权后重试
            await _run_adb(
                "shell", "pm grant com.android.shell android.permission.WRITE_SECURE_SETTINGS",
                device=serial,
            )
            code, stdout, stderr = await _run_adb(
                "shell", f"settings put global http_proxy {proxy}", device=serial
            )
        msg = f"代理已设置为 {proxy}"

    output = (stdout + stderr).strip()
    if code == 0:
        logger.info(f"[{serial}] {msg}")
        return True, msg
    else:
        logger.error(f"[{serial}] Proxy setting failed: {output}")
        return False, output


async def discover_mdns_services() -> list[dict]:
    """
    通过 adb mdns services 发现局域网内广播的 ADB 设备。
    返回格式: [{"service_name": "adb-xxx", "type": "_adb-tls-connect._tcp", "addr": "192.168.1.x:port"}, ...]
    """
    code, stdout, stderr = await _run_adb("mdns", "services", timeout=5)
    if code != 0:
        logger.debug(f"adb mdns services failed: {stderr}")
        return []

    services = []
    for line in stdout.strip().splitlines()[1:]:  # 跳过 header
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) >= 3 and parts[1] == "_adb-tls-connect._tcp":
            services.append({
                "service_name": parts[0],
                "type": parts[1],
                "addr": parts[2],
            })
    return services


async def auto_connect_mdns():
    """
    自动连接通过 mDNS 发现的已配对设备。
    对比当前已连接设备列表，只连接尚未连接的设备。
    """
    # 获取当前已连接的设备
    code, stdout, _ = await _run_adb("devices")
    if code != 0:
        return

    connected_addrs = set()
    for line in stdout.strip().splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            connected_addrs.add(parts[0])

    # 发现 mDNS 服务
    services = await discover_mdns_services()
    if not services:
        return

    for svc in services:
        addr = svc["addr"]
        if addr not in connected_addrs:
            logger.info(f"mDNS auto-connect: {svc['service_name']} at {addr}")
            code, out, err = await _run_adb("connect", addr)
            output = (out + err).strip()
            if "connected" in output.lower():
                logger.info(f"mDNS auto-connected to {addr}")
            else:
                logger.warning(f"mDNS auto-connect failed for {addr}: {output}")
