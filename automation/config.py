"""
ADB Worker 配置模块
启动参数用环境变量，运行时配置存数据库
"""

import os
import shutil


def _find_adb() -> str:
    """查找 adb 可执行文件路径"""
    env_adb = os.environ.get("ADB_PATH")
    if env_adb and os.path.isfile(env_adb):
        return env_adb

    adb_in_path = shutil.which("adb")
    if adb_in_path:
        return adb_in_path

    try:
        import adbutils
        # Cross-platform: use "adb.exe" on Windows, "adb" on Linux/macOS
        adb_name = "adb.exe" if os.name == "nt" else "adb"
        bundled = os.path.join(os.path.dirname(adbutils.__file__), "binaries", adb_name)
        if os.path.isfile(bundled):
            return bundled
    except ImportError:
        pass

    return "adb"


class Config:
    """启动参数（只读，来自环境变量）"""
    ADB_PATH: str = _find_adb()
    HOST: str = os.environ.get("HOST", "0.0.0.0")
    PORT: int = int(os.environ.get("PORT", "8080"))
    DB_PATH: str = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "adb_worker.db"))


config = Config()

# ====== 运行时配置默认值（会被 DB 中的值覆盖）======
SETTING_DEFAULTS = {
    "backend_url": "https://api.maiscorehub.bakapiano.com",
    "api_shared_secret": "",
    "poll_interval": "30",
    "device_scan_interval": "10",
    "log_retention_count": "500",
}
