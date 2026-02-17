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


async def list_devices() -> list[Device]:
    """列出所有已连接的 ADB 设备，并同步到数据库"""
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
