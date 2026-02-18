"""
SQLite 数据库管理
"""

import aiosqlite
import logging
from typing import Optional
from config import config, SETTING_DEFAULTS
from models import Device, Binding, RecoveryLog

logger = logging.getLogger("db")

_db: Optional[aiosqlite.Connection] = None


async def get_db() -> aiosqlite.Connection:
    global _db
    if _db is None:
        _db = await aiosqlite.connect(config.DB_PATH)
        _db.row_factory = aiosqlite.Row
        await _db.execute("PRAGMA journal_mode=WAL")
        await _init_tables(_db)
    return _db


async def close_db():
    global _db
    if _db:
        await _db.close()
        _db = None


async def _init_tables(db: aiosqlite.Connection):
    await db.executescript("""
        CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            name TEXT DEFAULT '',
            model TEXT DEFAULT '',
            status TEXT DEFAULT 'offline',
            last_seen TEXT
        );

        CREATE TABLE IF NOT EXISTS bindings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            friend_code TEXT NOT NULL,
            recovery_url TEXT NOT NULL,
            retry_interval INTEGER DEFAULT 30,
            last_recovery_at TEXT,
            recovery_count INTEGER DEFAULT 0,
            FOREIGN KEY (device_id) REFERENCES devices(id),
            UNIQUE(device_id, friend_code)
        );

        CREATE TABLE IF NOT EXISTS recovery_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            binding_id INTEGER NOT NULL,
            friend_code TEXT NOT NULL,
            device_id TEXT NOT NULL,
            recovery_url TEXT NOT NULL,
            status TEXT NOT NULL,
            message TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (binding_id) REFERENCES bindings(id)
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    """)
    await db.commit()

    # 数据库迁移：添加 remark 列
    try:
        await db.execute("ALTER TABLE devices ADD COLUMN remark TEXT DEFAULT ''")
        await db.commit()
    except Exception:
        pass  # 列已存在

    try:
        await db.execute("ALTER TABLE devices ADD COLUMN hardware_id TEXT DEFAULT ''")
        await db.commit()
    except Exception:
        pass  # 列已存在

    # 初始化默认设置
    for key, default_val in SETTING_DEFAULTS.items():
        await db.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            (key, default_val),
        )
    await db.commit()


# ====== Devices CRUD ======

async def upsert_device(device: Device) -> Device:
    db = await get_db()
    await db.execute(
        """INSERT INTO devices (id, name, model, status, last_seen, remark, hardware_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = COALESCE(NULLIF(excluded.name, ''), devices.name),
             model = COALESCE(NULLIF(excluded.model, ''), devices.model),
             status = excluded.status,
             last_seen = excluded.last_seen,
             hardware_id = COALESCE(NULLIF(excluded.hardware_id, ''), devices.hardware_id)
        """,
        (device.id, device.name, device.model, device.status, device.last_seen, device.remark, device.hardware_id),
    )
    await db.commit()
    return device


async def update_device_remark(device_id: str, remark: str):
    db = await get_db()
    await db.execute("UPDATE devices SET remark = ? WHERE id = ?", (remark, device_id))
    await db.commit()


async def get_device_by_hardware_id(hardware_id: str) -> Optional[Device]:
    """根据硬件序列号查找设备"""
    if not hardware_id:
        return None
    conn = await get_db()
    cursor = await conn.execute("SELECT * FROM devices WHERE hardware_id = ?", (hardware_id,))
    row = await cursor.fetchone()
    return Device(**dict(row)) if row else None


async def migrate_device_id(old_id: str, new_id: str):
    """设备 IP:port 变化时，将旧 ID 迁移到新 ID，同时更新绑定关系"""
    conn = await get_db()
    # 获取旧设备信息
    cursor = await conn.execute("SELECT * FROM devices WHERE id = ?", (old_id,))
    old_row = await cursor.fetchone()
    if not old_row:
        return
    old_device = dict(old_row)

    # 删除旧设备记录
    await conn.execute("DELETE FROM devices WHERE id = ?", (old_id,))

    # 插入新设备记录（保留备注等信息）
    await conn.execute(
        """INSERT INTO devices (id, name, model, status, last_seen, remark, hardware_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = COALESCE(NULLIF(excluded.name, ''), devices.name),
             model = COALESCE(NULLIF(excluded.model, ''), devices.model),
             remark = COALESCE(NULLIF(excluded.remark, ''), devices.remark),
             hardware_id = COALESCE(NULLIF(excluded.hardware_id, ''), devices.hardware_id),
             status = excluded.status,
             last_seen = excluded.last_seen
        """,
        (new_id, old_device.get('name', ''), old_device.get('model', ''),
         old_device.get('status', 'online'), old_device.get('last_seen', ''),
         old_device.get('remark', ''), old_device.get('hardware_id', '')),
    )

    # 更新绑定关系的 FK
    await conn.execute("UPDATE bindings SET device_id = ? WHERE device_id = ?", (new_id, old_id))

    # 更新恢复日志中的设备 ID
    await conn.execute("UPDATE recovery_logs SET device_id = ? WHERE device_id = ?", (new_id, old_id))

    await conn.commit()
    logger.info(f"Device migrated: {old_id} -> {new_id}")


async def get_all_devices() -> list[Device]:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM devices ORDER BY status DESC, last_seen DESC")
    rows = await cursor.fetchall()
    return [Device(**dict(r)) for r in rows]


async def mark_devices_offline(online_ids: set[str]):
    """将不在 online_ids 中的设备标记为 offline"""
    db = await get_db()
    if not online_ids:
        await db.execute("UPDATE devices SET status = 'offline'")
    else:
        placeholders = ",".join("?" for _ in online_ids)
        await db.execute(
            f"UPDATE devices SET status = 'offline' WHERE id NOT IN ({placeholders})",
            list(online_ids),
        )
    await db.commit()


async def delete_device(device_id: str):
    db = await get_db()
    await db.execute("DELETE FROM bindings WHERE device_id = ?", (device_id,))
    await db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
    await db.commit()


# ====== Bindings CRUD ======

async def create_binding(binding: Binding) -> Binding:
    db = await get_db()
    cursor = await db.execute(
        """INSERT INTO bindings (device_id, friend_code, recovery_url, retry_interval)
           VALUES (?, ?, ?, ?)""",
        (binding.device_id, binding.friend_code, binding.recovery_url, binding.retry_interval),
    )
    await db.commit()
    binding.id = cursor.lastrowid
    return binding


async def get_all_bindings() -> list[Binding]:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM bindings ORDER BY id")
    rows = await cursor.fetchall()
    return [Binding(**dict(r)) for r in rows]


async def get_binding_by_friend_code(friend_code: str) -> Optional[Binding]:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM bindings WHERE friend_code = ?", (friend_code,))
    row = await cursor.fetchone()
    return Binding(**dict(row)) if row else None


async def get_bindings_needing_recovery(unavailable_friend_codes: set[str]) -> list[Binding]:
    """获取需要恢复的绑定：Bot 不可用 + 超过重试间隔"""
    if not unavailable_friend_codes:
        return []
    db = await get_db()
    placeholders = ",".join("?" for _ in unavailable_friend_codes)
    cursor = await db.execute(
        f"""SELECT b.* FROM bindings b
            JOIN devices d ON b.device_id = d.id
            WHERE b.friend_code IN ({placeholders})
              AND d.status = 'online'
              AND (
                b.last_recovery_at IS NULL
                OR (julianday('now') - julianday(b.last_recovery_at)) * 86400 >= b.retry_interval
              )
        """,
        list(unavailable_friend_codes),
    )
    rows = await cursor.fetchall()
    return [Binding(**dict(r)) for r in rows]


async def update_binding_recovery(binding_id: int):
    db = await get_db()
    await db.execute(
        """UPDATE bindings
           SET last_recovery_at = datetime('now'),
               recovery_count = recovery_count + 1
           WHERE id = ?""",
        (binding_id,),
    )
    await db.commit()


async def delete_binding(binding_id: int):
    db = await get_db()
    await db.execute("DELETE FROM bindings WHERE id = ?", (binding_id,))
    await db.commit()


async def update_binding(binding_id: int, device_id: str = None, friend_code: str = None, recovery_url: str = None, retry_interval: int = None):
    db = await get_db()
    updates = []
    params = []
    if device_id is not None:
        updates.append("device_id = ?")
        params.append(device_id)
    if friend_code is not None:
        updates.append("friend_code = ?")
        params.append(friend_code)
    if recovery_url is not None:
        updates.append("recovery_url = ?")
        params.append(recovery_url)
    if retry_interval is not None:
        updates.append("retry_interval = ?")
        params.append(retry_interval)
    if updates:
        params.append(binding_id)
        await db.execute(
            f"UPDATE bindings SET {', '.join(updates)} WHERE id = ?",
            params,
        )
        await db.commit()


# ====== Recovery Logs ======

async def add_recovery_log(log: RecoveryLog) -> RecoveryLog:
    db = await get_db()
    cursor = await db.execute(
        """INSERT INTO recovery_logs (binding_id, friend_code, device_id, recovery_url, status, message)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (log.binding_id, log.friend_code, log.device_id, log.recovery_url, log.status, log.message),
    )
    log.id = cursor.lastrowid

    # 自动清理旧日志，只保留最近 N 条
    retention = int(await get_setting("log_retention_count"))
    await db.execute(
        """DELETE FROM recovery_logs WHERE id NOT IN (
               SELECT id FROM recovery_logs ORDER BY created_at DESC LIMIT ?
           )""",
        (retention,),
    )
    await db.commit()
    return log


async def get_recent_logs(limit: int = 50) -> list[RecoveryLog]:
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM recovery_logs ORDER BY created_at DESC LIMIT ?",
        (limit,),
    )
    rows = await cursor.fetchall()
    return [RecoveryLog(**dict(r)) for r in rows]


# ====== Settings CRUD ======

_settings_cache: dict[str, str] = {}


async def _load_settings_cache():
    """从 DB 加载所有设置到内存缓存"""
    global _settings_cache
    conn = await get_db()
    cursor = await conn.execute("SELECT key, value FROM settings")
    rows = await cursor.fetchall()
    _settings_cache = {r["key"]: r["value"] for r in rows}


async def get_setting(key: str) -> str:
    """获取设置值，优先从缓存读取"""
    if not _settings_cache:
        await _load_settings_cache()
    return _settings_cache.get(key, SETTING_DEFAULTS.get(key, ""))


async def get_all_settings() -> dict[str, str]:
    if not _settings_cache:
        await _load_settings_cache()
    return {**SETTING_DEFAULTS, **_settings_cache}


async def set_setting(key: str, value: str):
    conn = await get_db()
    await conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
        (key, value, value),
    )
    await conn.commit()
    _settings_cache[key] = value


async def set_settings(settings: dict[str, str]):
    conn = await get_db()
    for key, value in settings.items():
        await conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
            (key, value, value),
        )
    await conn.commit()
    _settings_cache.update(settings)
