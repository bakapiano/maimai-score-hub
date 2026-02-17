"""
Cookie 恢复服务
编排完整的恢复流程：检查设备 → 打开 WebView → 导航到恢复 URL → 处理拦截
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

import db
from models import Binding, RecoveryLog
from services import adb_service, cdp_service, bot_monitor

logger = logging.getLogger("recovery")

# 恢复锁：同一时间只能执行一个恢复任务
_recovery_lock = asyncio.Lock()
_running_recovery: Optional[str] = None  # 当前正在恢复的 friend_code


async def execute_recovery(binding: Binding) -> tuple[bool, str]:
    """
    执行单个 Bot 的 Cookie 恢复流程。
    返回 (success, message)
    """
    global _running_recovery

    if _recovery_lock.locked():
        return False, f"Another recovery is in progress: {_running_recovery}"

    async with _recovery_lock:
        _running_recovery = binding.friend_code
        try:
            return await _do_recovery(binding)
        finally:
            _running_recovery = None


async def _do_recovery(binding: Binding) -> tuple[bool, str]:
    """执行恢复流程的核心逻辑"""
    device_id = binding.device_id
    friend_code = binding.friend_code
    recovery_url = binding.recovery_url

    logger.info(f"[{friend_code}] Starting recovery on device {device_id}")

    # Step 1: 检查设备在线
    online = await adb_service.is_device_online(device_id)
    if not online:
        msg = f"Device {device_id} is offline"
        await _log_recovery(binding, "failed", msg)
        return False, msg

    # Step 2: 确保 WebView 可用并建立端口转发
    local_port = await cdp_service.ensure_forward(device_id)
    logger.info(f"[{friend_code}] CDP local port: {local_port}")
    if local_port is None:
        msg = f"Failed to establish CDP connection to {device_id}"
        await _log_recovery(binding, "failed", msg)
        return False, msg

    # Step 3: 导航到恢复 URL
    logger.info(f"[{friend_code}] Navigating to {recovery_url}")
    success, nav_msg = await cdp_service.navigate_and_handle_intercept(local_port, recovery_url)

    if not success:
        msg = f"Navigation failed: {nav_msg}"
        await _log_recovery(binding, "failed", msg)
        return False, msg

    # Step 4: 获取导航后的页面信息
    page_info = await cdp_service.get_page_info(local_port)
    if page_info:
        logger.info(f"[{friend_code}] Page after navigation: title={page_info.get('title')}, url={page_info.get('url')}")
    else:
        logger.warning(f"[{friend_code}] Could not get page info after navigation")

    # Step 5: 更新恢复记录
    await db.update_binding_recovery(binding.id)
    msg = f"Recovery triggered: {nav_msg}"
    await _log_recovery(binding, "success", msg)

    logger.info(f"[{friend_code}] Recovery completed: {msg}")
    return True, msg


async def _log_recovery(binding: Binding, status: str, message: str):
    """记录恢复日志"""
    log = RecoveryLog(
        binding_id=binding.id,
        friend_code=binding.friend_code,
        device_id=binding.device_id,
        recovery_url=binding.recovery_url,
        status=status,
        message=message,
    )
    await db.add_recovery_log(log)


async def check_and_recover():
    """
    检查所有 Bot 状态，对不可用且有绑定的 Bot 执行恢复。
    由定时任务调用。
    """
    # 1. 获取最新 Bot 状态
    await bot_monitor.fetch_bot_statuses()

    # 2. 找出不可用的 Bot
    unavailable = bot_monitor.get_unavailable_friend_codes()
    if not unavailable:
        logger.debug("All bots are available")
        return

    logger.info(f"Unavailable bots: {unavailable}")

    # 3. 查找需要恢复的绑定
    bindings = await db.get_bindings_needing_recovery(unavailable)
    logger.info(f"Bindings needing recovery: {[b.friend_code for b in bindings]}")
    if not bindings:
        logger.debug("No bindings need recovery at this time")
        return

    # 4. 逐个执行恢复
    for binding in bindings:
        success, msg = await execute_recovery(binding)
        logger.info(f"[{binding.friend_code}] Recovery result: {success} - {msg}")

        # 恢复之间等一下，避免太频繁
        if len(bindings) > 1:
            await asyncio.sleep(5)


def get_running_recovery() -> Optional[str]:
    """获取当前正在恢复的 friend_code"""
    return _running_recovery
