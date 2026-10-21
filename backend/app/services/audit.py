"""稽核日誌服務層(W7 首版)。

提供兩件事,路由層與主程式各取所需:

1. ``record()`` —— 端點內主動記一筆 ``AuditLog``。**不自行 commit**,只 ``flush``;
   讓呼叫端把稽核寫入與業務變更放進同一個交易一起提交(或一起回滾)。

2. ``AuditMiddleware`` —— 通用中介層。對「變更型」HTTP 請求
   (``POST/PUT/PATCH/DELETE`` 且路徑在 ``/api/v1/`` 下、且不在排除清單)
   於**回應成功(2xx)後**自動補記一筆稽核:
   - actor / tenant 由 ``Authorization: Bearer <JWT>`` 解出(解不出就跳過,
     視為匿名/公開請求,無從歸屬亦無租戶可隔離);
   - ``action`` = ``"METHOD path"``;``target`` 由路徑推斷;``ip`` 盡力而為;
   - **自帶獨立 DB session**、全程 ``try/except`` 降級,**記錄失敗絕不影響主請求**;
   - **絕不讀取/落庫請求 body**(避免把密碼、token 等機敏內容寫進稽核)。

註冊(由主 session 於 main.py 進行,本檔不掛):

    from app.services.audit import AuditMiddleware
    app.add_middleware(AuditMiddleware)
"""
from __future__ import annotations

import logging
import re
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import SessionLocal
from app.core.security import decode_access_token
from app.models.audit import AuditLog

logger = logging.getLogger("kefu.audit")

# 只稽核「變更型」方法(唯讀 GET/HEAD/OPTIONS 不記)。
_MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# 僅稽核租戶管理面 API。/api/ext/v1(開放 API 入口)不以 /api/v1/ 起始,天然排除;
# WebSocket 路由非 HTTP,也不會進到本中介層。
_AUDIT_PREFIX = "/api/v1/"

# 排除的「模組」前綴(高頻 / 公開 / 憑證面):
#   - auth      :登入/換發 token,body 帶密碼;認證事件另有機制,勿於此記。
#   - webhooks  :對外系統回呼(公開、無坐席歸屬、量大)。
#   - visitor   :訪客掛件面(高頻、常為公開/訪客 token)。
#   - public    :對外公開白牌設定。
_EXCLUDED_MODULE_PREFIXES = (
    "/api/v1/auth/",
    "/api/v1/webhooks/",
    "/api/v1/visitor/",
    "/api/v1/public/",
)

# 排除的高頻路徑片段(不分模組):送訊、頁面軌跡、輸入中、心跳等。
_EXCLUDED_PATH_SNIPPETS = (
    "/messages",
    "/message",
    "/pageview",
    "/page-view",
    "/pagetrail",
    "/trail",
    "/typing",
    "/heartbeat",
    "/presence",
)

# 判斷路徑段是否「像一個 id」(UUID 或純數字),用來把資源名與資源 id 分離。
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

# AuditLog.action 欄位為 String(80);雙 UUID 路徑(如 .../<uuid>/members/<uuid>)可能超長,
# 寫入前一律截斷,避免 DB 層值過長丟例外導致整筆稽核被降級靜默遺失。
_ACTION_MAX = 80


def _looks_like_id(seg: str) -> bool:
    return bool(_UUID_RE.match(seg)) or seg.isdigit()


def _infer_target(path: str) -> tuple[str | None, str | None]:
    """由路徑推斷 (target_type, target_id)。

    例:
        /api/v1/iam/staff/<uuid>            -> ("staff", "<uuid>")
        /api/v1/iam/roles/<uuid>/permissions-> ("roles", "<uuid>")
        /api/v1/channel                     -> ("channel", None)
    取模組後第一個非 id 段當 target_type,第一個 id-like 段當 target_id。
    """
    parts = [p for p in path.strip("/").split("/") if p]
    # 去掉 "api", "v1"
    rest = parts[2:] if len(parts) >= 2 else []
    if not rest:
        return None, None
    module = rest[0]
    tail = rest[1:]
    target_type: str | None = None
    target_id: str | None = None
    for seg in tail:
        if _looks_like_id(seg):
            if target_id is None:
                target_id = seg
        elif target_type is None:
            target_type = seg
    # 若模組下沒有子資源名,就以模組本身當 target_type(如 /channel 的直接建立)
    if target_type is None:
        target_type = module
    return target_type, target_id


def _client_ip(request: Request) -> str | None:
    """盡力取來源 IP:優先 X-Forwarded-For 首跳(反代/CF 隧道後),退回連線位址。"""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first[:64]
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()[:64]
    client = request.client
    return client.host[:64] if client else None


def _principal_from_request(request: Request) -> tuple[uuid.UUID, uuid.UUID] | None:
    """從 Authorization Bearer JWT 解出 (staff_id, tenant_id);任一環節失敗回 None。"""
    authz = request.headers.get("authorization")
    if not authz or not authz.lower().startswith("bearer "):
        return None
    payload = decode_access_token(authz.split(" ", 1)[1])
    if not payload:
        return None
    try:
        return uuid.UUID(payload["sub"]), uuid.UUID(payload["tenant_id"])
    except (KeyError, ValueError, TypeError):
        return None


def _should_audit(method: str, path: str) -> bool:
    if method not in _MUTATING_METHODS:
        return False
    if not path.startswith(_AUDIT_PREFIX):
        return False
    if any(path.startswith(pre) for pre in _EXCLUDED_MODULE_PREFIXES):
        return False
    if any(sn in path for sn in _EXCLUDED_PATH_SNIPPETS):
        return False
    return True


async def record(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    actor_staff_id: uuid.UUID | None = None,
    actor_name: str | None = None,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    ip: str | None = None,
    meta: dict | None = None,
) -> AuditLog:
    """寫一筆稽核(僅 add + flush,不 commit)。

    交由呼叫端把它併入既有交易一起 commit;若呼叫端最終 rollback,這筆稽核也會
    一併回滾,語意上與「該操作未發生」一致。需要獨立提交的場景(如中介層)請自備
    session 並自行 commit —— 見 ``AuditMiddleware``。
    """
    entry = AuditLog(
        tenant_id=tenant_id,
        actor_staff_id=actor_staff_id,
        actor_name=actor_name,
        action=action,
        target_type=target_type,
        target_id=target_id,
        ip=ip,
        meta=meta,
    )
    db.add(entry)
    await db.flush()
    return entry


class AuditMiddleware(BaseHTTPMiddleware):
    """通用稽核中介層:成功的變更型 /api/v1 請求 → 自動補記一筆。

    設計要點:
    - 只在 ``call_next`` 回應為 2xx 後才記(失敗的操作沒有落地,不需稽核)。
    - 自備獨立 session 並自行 commit,與主請求的交易解耦。
    - 全程降級:任何例外(解 JWT、寫 DB…)只記 warning,原樣回傳主回應。
    - 不觸碰 request body,零機敏外洩風險。
    """

    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        try:
            method = request.method.upper()
            path = request.url.path
            if not _should_audit(method, path):
                return response
            if not (200 <= response.status_code < 300):
                return response
            principal = _principal_from_request(request)
            if principal is None:
                return response  # 匿名/公開請求無從歸屬,略過
            staff_id, tenant_id = principal
            target_type, target_id = _infer_target(path)
            async with SessionLocal() as db:
                await record(
                    db,
                    tenant_id=tenant_id,
                    actor_staff_id=staff_id,
                    action=f"{method} {path}"[:_ACTION_MAX],
                    target_type=target_type,
                    target_id=target_id,
                    ip=_client_ip(request),
                    meta={"status": response.status_code},
                )
                await db.commit()
        except Exception:  # noqa: BLE001 - 稽核為旁路,絕不影響主請求
            logger.warning("稽核中介層記錄失敗(已降級,不影響主請求)", exc_info=True)
        return response
