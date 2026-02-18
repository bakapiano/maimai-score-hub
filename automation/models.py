"""
数据模型定义（用于 API 序列化）
"""

from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional


@dataclass
class Device:
    id: str  # ADB serial (IP:port or USB serial)
    name: str = ""
    model: str = ""
    status: str = "offline"  # online / offline
    last_seen: Optional[str] = None
    remark: str = ""
    hardware_id: str = ""  # 硬件序列号（ro.serialno），稳定标识符

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Binding:
    id: int = 0
    device_id: str = ""
    friend_code: str = ""
    recovery_url: str = ""
    retry_interval: int = 30
    last_recovery_at: Optional[str] = None
    recovery_count: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BotStatus:
    friend_code: str = ""
    available: bool = False
    friend_count: Optional[int] = None
    last_reported_at: Optional[str] = None
    remark: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class RecoveryLog:
    id: int = 0
    binding_id: int = 0
    friend_code: str = ""
    device_id: str = ""
    recovery_url: str = ""
    status: str = ""  # success / failed
    message: str = ""
    created_at: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)
