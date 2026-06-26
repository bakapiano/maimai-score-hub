"""
ADB Worker - FastAPI 主应用
提供 REST API + 嵌入式前端 + 后台定时任务
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import config
import db
from models import Binding
from services import adb_service, bot_monitor, cdp_service, recovery

# ====== Logging ======
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("app")

# ====== Background Tasks ======
_bg_tasks: list[asyncio.Task] = []


async def _device_scan_loop():
    """定期扫描 ADB 设备"""
    while True:
        try:
            await adb_service.list_devices()
        except Exception as e:
            logger.error(f"Device scan error: {e}")
        interval = int(await db.get_setting("device_scan_interval"))
        await asyncio.sleep(interval)


async def _bot_monitor_loop():
    """定期监控 Bot 状态并触发恢复"""
    await asyncio.sleep(5)
    while True:
        try:
            await recovery.check_and_recover()
        except Exception as e:
            logger.error(f"Bot monitor error: {e}")
        interval = int(await db.get_setting("poll_interval"))
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info(f"ADB Worker starting on {config.HOST}:{config.PORT}")
    logger.info(f"ADB path: {config.ADB_PATH}")

    await db.get_db()

    settings = await db.get_all_settings()
    logger.info(f"Backend: {settings.get('backend_url')}")
    logger.info(f"Poll interval: {settings.get('poll_interval')}s, Device scan: {settings.get('device_scan_interval')}s")

    _bg_tasks.append(asyncio.create_task(_device_scan_loop()))
    _bg_tasks.append(asyncio.create_task(_bot_monitor_loop()))

    yield

    # Shutdown
    for task in _bg_tasks:
        task.cancel()
    cdp_service.cleanup_forwards()
    await db.close_db()
    logger.info("ADB Worker stopped")


app = FastAPI(title="ADB Worker", lifespan=lifespan)

# ====== Static Files ======
static_dir = Path(__file__).parent / "static"
static_dir.mkdir(exist_ok=True)


# ====== Request Models ======
class PairRequest(BaseModel):
    ip: str
    port: int
    pairing_code: str


class ConnectRequest(BaseModel):
    ip: str
    port: int


class NotifyRequest(BaseModel):
    title: str = "ADB Worker"
    message: str = "这是你的设备"


class RemarkRequest(BaseModel):
    remark: str


class BindingCreate(BaseModel):
    device_id: str
    friend_code: str
    recovery_url: str
    retry_interval: int = 30


class BindingUpdate(BaseModel):
    device_id: Optional[str] = None
    friend_code: Optional[str] = None
    recovery_url: Optional[str] = None
    retry_interval: Optional[int] = None


class SettingsUpdate(BaseModel):
    backend_url: Optional[str] = None
    api_shared_secret: Optional[str] = None
    poll_interval: Optional[int] = None
    device_scan_interval: Optional[int] = None


# ====== Pages ======
@app.get("/", response_class=HTMLResponse)
async def index():
    index_file = static_dir / "index.html"
    if index_file.exists():
        return HTMLResponse(index_file.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>ADB Worker</h1><p>static/index.html not found</p>")


# ====== Devices API ======
@app.get("/api/devices")
async def api_list_devices():
    devices = await db.get_all_devices()
    return [d.to_dict() for d in devices]


@app.post("/api/devices/scan")
async def api_scan_devices():
    devices = await adb_service.list_devices()
    return {"count": len(devices), "devices": [d.to_dict() for d in devices]}


@app.post("/api/devices/pair")
async def api_pair_device(req: PairRequest):
    ok, msg = await adb_service.pair_device(req.ip, req.port, req.pairing_code)
    if not ok:
        raise HTTPException(400, msg)
    return {"success": True, "message": msg}


@app.post("/api/devices/connect")
async def api_connect_device(req: ConnectRequest):
    ok, msg = await adb_service.connect_device(req.ip, req.port)
    if not ok:
        raise HTTPException(400, msg)
    return {"success": True, "message": msg}


@app.get("/api/devices/{device_id:path}/info")
async def api_device_info(device_id: str):
    info = await adb_service.get_device_info(device_id)
    return info


@app.post("/api/devices/{device_id:path}/notify")
async def api_notify_device(device_id: str, req: NotifyRequest):
    ok, msg = await adb_service.send_notification(device_id, req.title, req.message)
    if not ok:
        raise HTTPException(400, msg)
    return {"success": True, "message": msg}


@app.put("/api/devices/{device_id:path}/remark")
async def api_update_device_remark(device_id: str, req: RemarkRequest):
    await db.update_device_remark(device_id, req.remark)
    return {"success": True}


@app.delete("/api/devices/{device_id:path}")
async def api_delete_device(device_id: str):
    await db.delete_device(device_id)
    return {"success": True}


@app.post("/api/devices/{device_id:path}/whitelist")
async def api_set_whitelist(device_id: str):
    """Add app to Doze whitelist and allow background running (for Drony etc.)"""
    results = []
    # Doze whitelist for Drony
    code, out, err = await adb_service._run_adb(
        "shell", "dumpsys deviceidle whitelist +org.sandroproxy.drony", device=device_id
    )
    results.append(f"doze whitelist: {(out + err).strip()}")
    # Allow background
    for op in ["RUN_IN_BACKGROUND", "RUN_ANY_IN_BACKGROUND"]:
        code, out, err = await adb_service._run_adb(
            "shell", f"cmd appops set org.sandroproxy.drony {op} allow", device=device_id
        )
        results.append(f"{op}: ok" if code == 0 else f"{op}: {(out + err).strip()}")
    return {"success": True, "results": results}


@app.post("/api/devices/{device_id:path}/push-apk")
async def api_push_apk(device_id: str):
    """Push Drony APK to device's /sdcard/Download/"""
    apk_path = Path(__file__).parent / "resources" / "drony.apk"
    if not apk_path.exists():
        raise HTTPException(404, "drony.apk not found in resources/")
    code, out, err = await adb_service._run_adb(
        "push", str(apk_path), "/sdcard/Download/drony.apk", device=device_id, timeout=30
    )
    output = (out + err).strip()
    if code != 0:
        raise HTTPException(400, output)
    return {"success": True, "message": output}


# ====== Bindings API ======
@app.get("/api/bindings")
async def api_list_bindings():
    bindings = await db.get_all_bindings()
    return [b.to_dict() for b in bindings]


@app.post("/api/bindings")
async def api_create_binding(req: BindingCreate):
    binding = Binding(
        device_id=req.device_id,
        friend_code=req.friend_code,
        recovery_url=req.recovery_url,
        retry_interval=req.retry_interval,
    )
    try:
        result = await db.create_binding(binding)
        return result.to_dict()
    except Exception as e:
        raise HTTPException(400, str(e))


@app.put("/api/bindings/{binding_id}")
async def api_update_binding(binding_id: int, req: BindingUpdate):
    await db.update_binding(
        binding_id,
        device_id=req.device_id,
        friend_code=req.friend_code,
        recovery_url=req.recovery_url,
        retry_interval=req.retry_interval,
    )
    return {"success": True}


@app.delete("/api/bindings/{binding_id}")
async def api_delete_binding(binding_id: int):
    await db.delete_binding(binding_id)
    return {"success": True}


# ====== Bot Status API ======
@app.get("/api/bots")
async def api_bot_statuses():
    statuses = bot_monitor.get_cached_statuses()
    return [s.to_dict() for s in statuses]


@app.post("/api/bots/refresh")
async def api_refresh_bots():
    statuses = await bot_monitor.fetch_bot_statuses()
    return [s.to_dict() for s in statuses]


# ====== Recovery API ======
@app.post("/api/recovery/{friend_code}")
async def api_trigger_recovery(friend_code: str):
    binding = await db.get_binding_by_friend_code(friend_code)
    if not binding:
        raise HTTPException(404, f"No binding for friend_code: {friend_code}")

    ok, msg = await recovery.execute_recovery(binding)
    if not ok:
        raise HTTPException(500, msg)
    return {"success": True, "message": msg}


@app.get("/api/logs")
async def api_recovery_logs(limit: int = 50):
    logs = await db.get_recent_logs(limit)
    return [l.to_dict() for l in logs]


# ====== Status API ======
@app.get("/api/status")
async def api_status():
    devices = await db.get_all_devices()
    bindings = await db.get_all_bindings()
    bot_statuses = bot_monitor.get_cached_statuses()
    settings = await db.get_all_settings()
    return {
        "devices": {
            "total": len(devices),
            "online": sum(1 for d in devices if d.status == "online"),
        },
        "bindings": len(bindings),
        "bots": {
            "total": len(bot_statuses),
            "available": sum(1 for s in bot_statuses if s.available),
            "unavailable": sum(1 for s in bot_statuses if not s.available),
        },
        "running_recovery": recovery.get_running_recovery(),
        "monitor_error": bot_monitor.get_last_error(),
        "config": {
            "backend_url": settings.get("backend_url", ""),
            "poll_interval": int(settings.get("poll_interval", "30")),
            "device_scan_interval": int(settings.get("device_scan_interval", "10")),
        },
    }


# ====== Settings API ======
@app.get("/api/settings")
async def api_get_settings():
    settings = await db.get_all_settings()
    return settings


@app.put("/api/settings")
async def api_update_settings(req: SettingsUpdate):
    updates = {}
    if req.backend_url is not None:
        updates["backend_url"] = req.backend_url.rstrip("/")
    if req.api_shared_secret is not None:
        updates["api_shared_secret"] = req.api_shared_secret
    if req.poll_interval is not None:
        updates["poll_interval"] = str(req.poll_interval)
    if req.device_scan_interval is not None:
        updates["device_scan_interval"] = str(req.device_scan_interval)
    if updates:
        await db.set_settings(updates)
    return {"success": True}


# ====== Entry Point ======
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
    )
