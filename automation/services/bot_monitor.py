"""
Bot 状态监控服务
定期从后端获取 Bot 状态，识别不可用的 Bot
"""

import asyncio
import logging
from typing import Optional

import httpx

import db
from models import BotStatus

logger = logging.getLogger("bot_monitor")

_bot_statuses: list[BotStatus] = []
_last_error: Optional[str] = None


async def fetch_bot_statuses() -> list[BotStatus]:
    """从后端获取所有 Bot 状态"""
    global _bot_statuses, _last_error

    backend_url = await db.get_setting("backend_url")
    api_shared_secret = await db.get_setting("api_shared_secret")

    if not api_shared_secret:
        _last_error = "api_shared_secret 未配置"
        logger.warning(_last_error)
        return []

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{backend_url}/api/v1/admin/bots",
                headers={"x-api-secret": api_shared_secret},
                timeout=10,
            )

            if resp.status_code != 200:
                _last_error = f"Backend returned {resp.status_code}: {resp.text[:200]}"
                logger.error(_last_error)
                return _bot_statuses

            data = resp.json()
            statuses = []
            for item in data:
                statuses.append(BotStatus(
                    friend_code=item.get("friendCode", ""),
                    available=item.get("available", False),
                    friend_count=item.get("friendCount"),
                    last_reported_at=item.get("lastReportedAt"),
                    remark=item.get("remark"),
                ))

            _bot_statuses = statuses
            _last_error = None
            logger.debug(f"Fetched {len(statuses)} bot statuses")
            return statuses

    except Exception as e:
        _last_error = str(e)
        logger.error(f"Failed to fetch bot statuses: {e}")
        return _bot_statuses


def get_cached_statuses() -> list[BotStatus]:
    """获取缓存的 Bot 状态"""
    return _bot_statuses


def get_unavailable_friend_codes() -> set[str]:
    """获取所有不可用的 Bot friend_code"""
    return {s.friend_code for s in _bot_statuses if not s.available}


def get_last_error() -> Optional[str]:
    return _last_error
