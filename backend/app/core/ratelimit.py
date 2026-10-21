"""輕量速率限制(Redis 固定視窗計數)。

用於認證面(登入 / OTP / 忘記密碼)防暴力破解與濫用。以 Redis INCR + EX 實作,
Redis 不可用時保守放行(不因限流基礎設施故障而拒絕正常使用者)。
"""
from __future__ import annotations

import ipaddress
import os

# 可信代理跳數:客戶端與本後端之間、由我方掌控且可信的反向代理數量,含最靠近本
# 服務的 socket peer(通常是 nginx)。典型 CF→nginx→後端 ⇒ 2(nginx 為 peer、
# Cloudflare 再往外一跳)。以環境變數 ``KEFU_TRUSTED_PROXY_HOPS`` 覆寫(不動
# config.py),模組層快取一次;非法/未設時退回預設 2。
_DEFAULT_TRUSTED_PROXY_HOPS = 2
_trusted_proxy_hops_cache: int | None = None


def _trusted_proxy_hops() -> int:
    """讀取並快取可信代理跳數(≥0)。非法值退回預設,避免因設定錯誤而崩潰。"""
    global _trusted_proxy_hops_cache
    if _trusted_proxy_hops_cache is None:
        raw = os.environ.get("KEFU_TRUSTED_PROXY_HOPS")
        try:
            hops = int(raw) if raw is not None and raw.strip() != "" else _DEFAULT_TRUSTED_PROXY_HOPS
        except (TypeError, ValueError):
            hops = _DEFAULT_TRUSTED_PROXY_HOPS
        _trusted_proxy_hops_cache = hops if hops >= 0 else _DEFAULT_TRUSTED_PROXY_HOPS
    return _trusted_proxy_hops_cache


def _valid_ip(value: str) -> str | None:
    """回傳正規化後的 IP 字串;非法則回 None。"""
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return None


async def hit(key: str, *, limit: int, window_seconds: int) -> bool:
    """對 key 記一次;回傳 True=允許、False=已超過視窗內上限。

    key 建議帶用途前綴,如 ``login:{email}`` / ``login-ip:{ip}``。
    """
    try:
        from app.services import realtime

        client = realtime.get_client()
        full = f"rl:{key}"
        n = await client.incr(full)
        if n == 1:
            await client.expire(full, window_seconds)
        return int(n) <= limit
    except Exception:
        # 限流基礎設施故障 → 保守放行(可用性優先於嚴格限流)
        return True


def client_ip(request) -> str:
    """盡力取得呼叫端真實 IP,用作限流鍵。

    安全模型(可信代理跳數):**不信任** X-Forwarded-For 最左跳——攻擊者可任意
    偽造左側項來輪換限流鍵、繞過 IP 限流。改採「從可信端(右側)往左數固定跳數」:

    - 完整位址鏈 = X-Forwarded-For 串列 + [socket peer(``request.client.host``)]。
      鏈的最右端是最靠近本服務的可信代理(peer),往左依序是更外層的可信代理。
    - 取 ``KEFU_TRUSTED_PROXY_HOPS``(預設 2)個最右側項視為我方可信代理,**再往左
      的那一個** IP 即真實客戶端。攻擊者只能在左側塞偽造項,因我方固定「從右數」,
      被選中的位置不受其影響。
    - X-Forwarded-For 缺失或項數不足(不足以往左數到客戶端)⇒ 退回 socket peer。
    - 選中的 IP 需通過格式驗證,非法則退回 peer(再不行回 ``"unknown"``)。

    介面簽章維持不變(僅接受 request、回傳字串),只調整內部取值邏輯。
    """
    try:
        peer = None
        try:
            peer = request.client.host if request.client else None
        except Exception:
            peer = None
        peer_valid = _valid_ip(peer) if peer else None

        xff = request.headers.get("x-forwarded-for")
        parts = [p.strip() for p in xff.split(",")] if xff else []
        parts = [p for p in parts if p]

        # 完整位址鏈:XFF 串列在左,socket peer 在最右(最靠近本服務、最可信)。
        chain = parts + ([peer] if peer else [])
        hops = _trusted_proxy_hops()

        # 去掉最右側 hops 個可信代理後,「再往左的那一個」即客戶端。
        idx = len(chain) - 1 - hops
        if idx >= 0:
            candidate = _valid_ip(chain[idx])
            if candidate is not None:
                return candidate

        # XFF 不足/缺失,或選中項非法 ⇒ 退回 socket peer。
        if peer_valid is not None:
            return peer_valid
        return peer or "unknown"
    except Exception:
        return "unknown"
