"""
Chrome DevTools Protocol (CDP) WebView 控制服务
负责端口转发管理、WebView 导航、JS 执行
"""

import asyncio
import json
import logging
from typing import Optional

import httpx
import websockets

from services import adb_service

logger = logging.getLogger("cdp_service")

# 设备 serial -> (local_port, socket_name) 映射
_port_map: dict[str, tuple[int, str]] = {}
_next_port = 9222


def _allocate_port() -> int:
    global _next_port
    port = _next_port
    _next_port += 1
    return port


async def ensure_forward(device_serial: str) -> Optional[int]:
    """
    确保设备的 WebView devtools 端口转发已建立。
    返回本地端口号，失败返回 None。
    """
    # 检查现有转发是否还有效
    if device_serial in _port_map:
        local_port, socket_name = _port_map[device_serial]
        if await _check_port_alive(local_port):
            return local_port
        # 端口失效，清理
        del _port_map[device_serial]

    # 查找微信 WebView socket
    sockets = await adb_service.get_webview_sockets(device_serial, package="com.tencent.mm")
    logger.info(f"[{device_serial}] WeChat WebView sockets: {sockets}")
    if not sockets:
        # 尝试触发
        ok = await adb_service.ensure_wechat_webview(device_serial)
        if not ok:
            return None
        sockets = await adb_service.get_webview_sockets(device_serial, package="com.tencent.mm")
        if not sockets:
            return None

    socket_name = sockets[0]
    local_port = _allocate_port()

    ok = await adb_service.forward_port(device_serial, local_port, socket_name)
    if not ok:
        return None

    _port_map[device_serial] = (local_port, socket_name)
    logger.info(f"[{device_serial}] CDP forwarded on port {local_port} ({socket_name})")
    return local_port


async def _check_port_alive(port: int) -> bool:
    """检查本地端口的 CDP 是否响应"""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"http://localhost:{port}/json", timeout=3)
            return resp.status_code == 200
    except Exception:
        return False


async def get_pages(local_port: int) -> list[dict]:
    """获取可调试的 WebView 页面列表"""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"http://localhost:{local_port}/json", timeout=5)
            return resp.json()
    except Exception as e:
        logger.error(f"Failed to get pages on port {local_port}: {e}")
        return []


async def _get_first_page_ws(local_port: int) -> Optional[str]:
    """获取第一个可见页面的 WebSocket URL"""
    pages = await get_pages(local_port)
    if not pages:
        return None

    # 优先选 visible 的页面
    for page in pages:
        desc = page.get("description", "")
        if '"visible":true' in desc:
            return page.get("webSocketDebuggerUrl")

    # 没有 visible 的就用第一个
    return pages[0].get("webSocketDebuggerUrl") if pages else None


async def navigate(local_port: int, url: str) -> tuple[bool, str]:
    """
    在 WebView 中导航到指定 URL。
    返回 (success, message)
    """
    ws_url = await _get_first_page_ws(local_port)
    if not ws_url:
        return False, "No WebView page available"

    try:
        async with websockets.connect(ws_url) as ws:
            # 发送导航命令
            cmd = json.dumps({
                "id": 1,
                "method": "Page.navigate",
                "params": {"url": url},
            })
            await ws.send(cmd)
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))

            # 检查是否有错误
            if "error" in resp:
                return False, f"Navigate error: {resp['error']}"

            result = resp.get("result", {})
            error_text = result.get("errorText")
            if error_text:
                return False, f"Page error: {error_text}"

            # 等待页面加载
            await asyncio.sleep(3)

            # 获取当前页面信息
            page_info = await _evaluate_js(ws, "document.title + '|||' + window.location.href")
            return True, f"Navigated: {page_info}"

    except Exception as e:
        logger.error(f"Navigate failed: {e}")
        return False, str(e)


async def navigate_and_handle_intercept(local_port: int, url: str) -> tuple[bool, str]:
    """
    导航到 URL 并处理微信安全拦截页面。
    如果遇到"继续访问"按钮则自动点击。
    """
    ws_url = await _get_first_page_ws(local_port)
    if not ws_url:
        return False, "No WebView page available"

    try:
        async with websockets.connect(ws_url) as ws:
            # 1. 导航
            cmd = json.dumps({
                "id": 1,
                "method": "Page.navigate",
                "params": {"url": url},
            })
            await ws.send(cmd)
            resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))

            result = resp.get("result", {})
            error_text = result.get("errorText")
            if error_text:
                return False, f"Page error: {error_text}"

            await asyncio.sleep(3)

            # 2. 检查是否被微信拦截
            body_text = await _evaluate_js(ws, "document.body?.innerText?.substring(0, 500) || ''")

            if "继续访问" in body_text:
                logger.info("Detected WeChat intercept page, clicking '继续访问'...")
                click_result = await _evaluate_js(ws, """
                    (function() {
                        var links = document.querySelectorAll('a, .weui-btn, button, [role=button]');
                        for (var i = 0; i < links.length; i++) {
                            var text = links[i].innerText || links[i].textContent;
                            if (text && text.indexOf('继续访问') >= 0) {
                                links[i].click();
                                return 'clicked';
                            }
                        }
                        return 'not_found';
                    })()
                """)

                if click_result == "clicked":
                    await asyncio.sleep(3)
                    final_url = await _evaluate_js(ws, "window.location.href")
                    final_title = await _evaluate_js(ws, "document.title")
                    return True, f"Intercepted & continued -> {final_title} | {final_url}"
                else:
                    return False, "Could not find '继续访问' button"

            # 3. 没有拦截，直接成功
            current_url = await _evaluate_js(ws, "window.location.href")
            current_title = await _evaluate_js(ws, "document.title")
            return True, f"{current_title} | {current_url}"

    except Exception as e:
        logger.error(f"Navigate with intercept handling failed: {e}")
        return False, str(e)


async def get_page_info(local_port: int) -> Optional[dict]:
    """获取当前 WebView 页面信息"""
    ws_url = await _get_first_page_ws(local_port)
    if not ws_url:
        return None

    try:
        async with websockets.connect(ws_url) as ws:
            title = await _evaluate_js(ws, "document.title")
            url = await _evaluate_js(ws, "window.location.href")
            return {"title": title, "url": url}
    except Exception:
        return None


async def _evaluate_js(ws, expression: str, msg_id: int = None) -> str:
    """通过 CDP 执行 JS 并返回结果字符串"""
    if msg_id is None:
        import random
        msg_id = random.randint(100, 99999)

    cmd = json.dumps({
        "id": msg_id,
        "method": "Runtime.evaluate",
        "params": {"expression": expression},
    })
    await ws.send(cmd)

    # 等待对应 id 的响应
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        resp = json.loads(raw)
        if resp.get("id") == msg_id:
            result = resp.get("result", {}).get("result", {})
            return result.get("value", "")


def cleanup_forwards():
    """清理所有端口转发"""
    _port_map.clear()


def get_forwarded_port(device_serial: str) -> Optional[int]:
    """获取设备当前转发的本地端口"""
    if device_serial in _port_map:
        return _port_map[device_serial][0]
    return None
