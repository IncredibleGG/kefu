"""對外 Webhook 派送服務。

對外主入口:

    async def deliver_event(db, tenant_id, event, payload) -> None

會話生命週期埋點(services/conversation.py、api/v1/conversation.py)在關鍵處呼叫
deliver_event。流程:

  1. 取該租戶、訂閱此 event、is_active 的 WebhookEndpoint。
  2. 對每個 endpoint POST JSON ``{event, data, ts}``,帶標頭
     ``X-Kefu-Signature: <HMAC-SHA256(secret, body) 的 hexdigest>``。
  3. 送達失敗(連線錯誤或 HTTP >= 400)以有限次退避重試。

設計要點:
- **降級不拋**:deliver_event 絕不向呼叫端拋例外;單一 endpoint 失敗只記錄,不影響
  其餘 endpoint 與主流程(呼叫端交易照常提交)。
- **唯讀 DB**:僅查詢 endpoint,不寫入,不干擾呼叫端交易。
- **事件過濾在 Python 端**:載入本租戶啟用中的 endpoints 後以成員判斷過濾訂閱,
  避免 JSONB 陣列查詢在不同資料庫(含測試 SQLite)行為分歧。
- **簽章對「實際送出的位元組」計算**:先序列化 body 字串,再對同一字串算 HMAC,
  最後以該字串為 request body 送出,確保接收端可重現驗章。

所有 DB 查詢一律以 tenant_id 過濾。
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.webhook import WebhookEndpoint
from app.services.ingest import net_guard

logger = logging.getLogger("kefu.webhooks")

# 簽章標頭名
SIGNATURE_HEADER = "X-Kefu-Signature"
# 事件標頭名(便於接收端不解 body 即路由)
EVENT_HEADER = "X-Kefu-Event"

# 重試:總嘗試次數與退避基數(秒);第 n 次失敗後睡 _BACKOFF_BASE * 2**(n-1)
_MAX_ATTEMPTS = 3
_BACKOFF_BASE = 0.5
# 單次請求逾時(秒)
_TIMEOUT = 5.0


# --------------------------------------------------------------------------- #
# 純函式:簽章 / body 組裝(無 IO,便於單元測試)
# --------------------------------------------------------------------------- #
def sign(secret: str, body: str) -> str:
    """對 body 以 secret 算 HMAC-SHA256,回傳 hexdigest。"""
    return hmac.new(
        secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def build_body(event: str, data: dict | None, ts: str | None = None) -> str:
    """組出要送出的 JSON 字串 ``{event, data, ts}``(穩定序列化)。"""
    return json.dumps(
        {
            "event": event,
            "data": data or {},
            "ts": ts or datetime.now(UTC).isoformat(),
        },
        ensure_ascii=False,
        separators=(",", ":"),
        default=str,
    )


# --------------------------------------------------------------------------- #
# IO:單次送出 / 帶重試送出(可被測試 monkeypatch)
# --------------------------------------------------------------------------- #
async def _sleep(seconds: float) -> None:
    """退避睡眠;抽成函式便於測試以 monkeypatch 略過等待。"""
    await asyncio.sleep(seconds)


async def _send(url: str, body: str, signature: str, event: str) -> int:
    """對 url 送一次 POST,回傳 HTTP 狀態碼(連線錯誤則由呼叫端捕捉)。

    SSRF 防護:發請求「前」再次以 net_guard 解析主機並封鎖私網/loopback/link-local
    (含雲端 metadata 169.254.169.254)/reserved/CGNAT 等位址,並拒非 http/https。
    不可只信任建立時的驗證——此處對「解析後的實際 IP」重驗,緩解 DNS rebinding /
    TOCTOU(建立時解析為公網、送出時改指內網)。被拒時拋 BlockedURLError,由
    _deliver_one 攔截並放棄送出(不重試)。httpx 預設不跟隨轉址(follow_redirects
    為 False),故 3xx 轉址不會被跟進而繞過此檢查。
    """
    await net_guard.assert_url_public_async(url)
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(
            url,
            content=body.encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                SIGNATURE_HEADER: signature,
                EVENT_HEADER: event,
            },
        )
        return resp.status_code


async def _deliver_one(url: str, secret: str, event: str, data: dict | None) -> bool:
    """對單一 endpoint 送出(含重試退避)。成功回 True,最終失敗回 False。

    絕不拋例外:任何連線 / HTTP / 其他例外都轉為重試或最終降級。
    """
    body = build_body(event, data)
    signature = sign(secret, body)
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            code = await _send(url, body, signature, event)
            if 200 <= code < 300:
                return True
            logger.warning(
                "webhook 送出非 2xx(url=%s event=%s status=%s attempt=%s)",
                url, event, code, attempt,
            )
        except net_guard.BlockedURLError:
            # SSRF 防護攔下:目標指向私網/內網/非法 scheme,立即放棄(重試無意義)。
            logger.warning(
                "webhook 目標被 SSRF 防護封鎖,放棄送出(url=%s event=%s)", url, event,
            )
            return False
        except Exception:
            logger.warning(
                "webhook 送出例外(url=%s event=%s attempt=%s)",
                url, event, attempt, exc_info=True,
            )
        if attempt < _MAX_ATTEMPTS:
            await _sleep(_BACKOFF_BASE * (2 ** (attempt - 1)))
    return False


# --------------------------------------------------------------------------- #
# 查詢:訂閱某事件且啟用中的 endpoints(租戶隔離)
# --------------------------------------------------------------------------- #
async def _load_subscribed(
    db: AsyncSession, tenant_id: uuid.UUID, event: str
) -> list[WebhookEndpoint]:
    """取本租戶啟用中的 endpoints,並以 Python 過濾出訂閱此 event 者。"""
    rows = (
        await db.execute(
            select(WebhookEndpoint).where(
                WebhookEndpoint.tenant_id == tenant_id,
                WebhookEndpoint.is_active.is_(True),
                WebhookEndpoint.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    return [ep for ep in rows if event in (ep.events or [])]


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
async def deliver_event(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    event: str,
    payload: dict[str, Any],
) -> None:
    """派送一個事件給本租戶所有訂閱的 endpoints。**絕不拋例外**(失敗降級記錄)。

    - event:見 models.webhook.WEBHOOK_EVENTS。
    - payload:事件資料(送出 body 的 ``data`` 欄位)。
    """
    try:
        endpoints = await _load_subscribed(db, tenant_id, event)
        if not endpoints:
            return
        # 併發送出各 endpoint;單一失敗不影響其餘(_deliver_one 自身已降級)
        await asyncio.gather(
            *(_deliver_one(ep.url, ep.secret, event, payload) for ep in endpoints),
            return_exceptions=True,
        )
    except Exception:
        logger.exception(
            "webhook deliver_event 失敗 event=%s tenant=%s", event, tenant_id
        )


async def send_test(
    url: str, secret: str, event: str = "webhook.test", data: dict | None = None
) -> bool:
    """管理端「測試發送」用:對單一 endpoint 送一則測試事件,回傳是否成功。"""
    return await _deliver_one(url, secret, event, data or {"message": "kefu webhook test"})
