"""行動推播(FCM HTTP v1;docs/NATIVE-CLIENTS.md §4.3)。程式碼就緒,**沒設定時完全不動作**。

設定(直接讀 os.environ,比照 KEFU_GOOGLE_*):
- ``KEFU_FCM_SERVICE_ACCOUNT_JSON``:服務帳號 JSON 內容,或 JSON 檔案路徑。
- ``KEFU_FCM_PROJECT_ID``:選填,預設取服務帳號 JSON 的 ``project_id``。
- ``KEFU_PUSH_PREVIEW``:預設 true;false 時通知不帶訊息內容 / 訪客名稱,只顯示「新訊息」類固定字樣。

對外入口(皆為**同步**函式、絕不拋錯;未設定時直接回 None,不建立任何任務):

    on_visitor_message(tenant_id, session_id, message_id)      # 新訪客訊息 → 負責坐席
    on_assigned(tenant_id, session_id, staff_id, actor)        # 指派給我(actor 為本人時不推)
    on_transfer(tenant_id, session_id, target_staff_id, actor) # 轉接給我(轉給自己不推)

呼叫端一律放在 **commit 之後**(避免交易回滾後通知已送出)。實際工作以
``asyncio.create_task`` 背景執行(模組層 set 保留強參照,避免任務被 GC 中途回收),
任務內自己開 ``SessionLocal``,不共用呼叫端的交易。

送出前的判斷(任一不符即不推):
1. 重新讀取會話 / 坐席 / 租戶:坐席 ``is_active`` 且未軟刪、租戶 ``is_active``(同 deps 撤銷邏輯);
   訊息推播只推給 ``handler_type=="human"`` 的負責坐席;指派 / 轉接要求會話仍歸該坐席。
2. ``presence.is_foreground(staff)``:該坐席任一裝置有前景連線 → 不推(避免與 App 內通知重複)。
3. Redis ``SET push:dedupe:{staff}:{session}:{kind} NX EX 15``:同會話同類型 15 秒內只推一次
   (Redis 不可用時放行;寧可多推不漏)。
4. 該坐席未撤銷的 ios / android 裝置(桌面只登記不推)。

FCM:服務帳號以 python-jose RS256 簽 JWT,向 oauth2.googleapis.com 換 access token,
快取到過期前 300 秒。404 UNREGISTERED / 400 INVALID_ARGUMENT → 該權杖設 ``revoked_at``;
429 / 5xx / 連線錯誤最多重試 2 次;401 清快取重換 token 一次。日誌**不記錄**權杖、access token 或私鑰。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import httpx

logger = logging.getLogger("kefu.push")

ENV_SERVICE_ACCOUNT = "KEFU_FCM_SERVICE_ACCOUNT_JSON"
ENV_PROJECT_ID = "KEFU_FCM_PROJECT_ID"
ENV_PREVIEW = "KEFU_PUSH_PREVIEW"

FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
# 固定 Google 端點(不採用服務帳號 JSON 內的 token_uri,避免設定被導向他處)
OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
FCM_SEND_URL = "https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"

# Android 通知頻道(契約 §2 固定常數)
ANDROID_CHANNEL_ID = "kefu_messages"
# 同會話同類型合併視窗(秒)
DEDUPE_SECONDS = 15
DEDUPE_PREFIX = "push:dedupe:"
# 429 / 5xx 重試次數與退避(秒);測試可改小
MAX_RETRIES = 2
RETRY_BACKOFF: tuple[float, ...] = (0.5, 1.5)
# access token 於過期前多少秒視為過期(提前換新)
TOKEN_REFRESH_MARGIN = 300
HTTP_TIMEOUT_SECONDS = 10.0
# 推播內容長度上限
_TITLE_MAX = 60
_BODY_MAX = 120

KIND_MESSAGE = "message"
KIND_ASSIGNED = "assigned"
KIND_TRANSFER = "transfer"
KINDS = (KIND_MESSAGE, KIND_ASSIGNED, KIND_TRANSFER)

# FCM 回報「這個權杖不能再用」的錯誤碼(UNREGISTERED 任何狀態碼;INVALID_ARGUMENT 限 400)
_REVOKE_CODES = {"UNREGISTERED", "INVALID_ARGUMENT"}
_PROJECT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{3,62}$")


# =========================================================================== #
# 測試掛鉤
# =========================================================================== #
_transport: httpx.AsyncBaseTransport | None = None
_session_factory: Callable[[], Any] | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    """測試掛鉤:注入 httpx transport(例 ``httpx.MockTransport``),不打真實網路。"""
    global _transport
    _transport = transport


def set_session_factory(factory: Callable[[], Any] | None) -> None:
    """測試掛鉤:注入 DB session factory(預設 ``app.core.db.SessionLocal``)。"""
    global _session_factory
    _session_factory = factory


def _open_session():
    if _session_factory is not None:
        return _session_factory()
    from app.core.db import SessionLocal

    return SessionLocal()


# =========================================================================== #
# 設定
# =========================================================================== #
_sa_cache: dict[str, dict | None] = {}


def _parse_service_account(raw: str) -> dict | None:
    raw = raw.strip()
    if not raw:
        return None
    text = raw
    if not raw.startswith("{"):
        try:
            with open(os.path.expanduser(raw), encoding="utf-8") as fh:
                text = fh.read()
        except OSError:
            logger.warning("%s 指向的檔案無法讀取,推播停用", ENV_SERVICE_ACCOUNT)
            return None
    try:
        data = json.loads(text)
    except ValueError:
        logger.warning("%s 不是合法 JSON,推播停用", ENV_SERVICE_ACCOUNT)
        return None
    if not isinstance(data, dict):
        return None
    if not isinstance(data.get("client_email"), str) or not isinstance(data.get("private_key"), str):
        logger.warning("%s 缺 client_email / private_key,推播停用", ENV_SERVICE_ACCOUNT)
        return None
    return data


def _service_account() -> dict | None:
    raw = os.environ.get(ENV_SERVICE_ACCOUNT, "")
    if not raw.strip():
        return None
    if raw not in _sa_cache:
        _sa_cache.clear()  # 只保留目前這組設定
        _sa_cache[raw] = _parse_service_account(raw)
    return _sa_cache[raw]


def _project_id(sa: dict) -> str | None:
    pid = (os.environ.get(ENV_PROJECT_ID) or "").strip() or str(sa.get("project_id") or "").strip()
    if not pid or not _PROJECT_ID_RE.match(pid):
        return None
    return pid


def is_configured() -> bool:
    """推播是否可用(服務帳號可解析且有合法 project id)。絕不拋錯。"""
    try:
        sa = _service_account()
        return bool(sa and _project_id(sa))
    except Exception:  # noqa: BLE001
        logger.warning("推播設定檢查失敗,視為未設定", exc_info=True)
        return False


def preview_enabled() -> bool:
    """``KEFU_PUSH_PREVIEW``(預設 true):false 時通知不帶內容。"""
    val = (os.environ.get(ENV_PREVIEW) or "").strip().lower()
    return val not in ("0", "false", "no", "off")


# =========================================================================== #
# 在地化
# =========================================================================== #
_TEXTS: dict[str, dict[str, str]] = {
    "zh-Hant": {
        "message_title": "新訊息",
        "message_body": "訪客傳來一則新訊息",
        "message_media": "[附件]",
        "assigned_title": "有會話指派給你",
        "assigned_body": "點擊查看會話",
        "transfer_title": "有會話轉接給你",
        "transfer_body": "點擊查看會話",
        "visitor": "訪客",
    },
    "zh-CN": {
        "message_title": "新消息",
        "message_body": "访客发来一条新消息",
        "message_media": "[附件]",
        "assigned_title": "有会话分配给你",
        "assigned_body": "点击查看会话",
        "transfer_title": "有会话转接给你",
        "transfer_body": "点击查看会话",
        "visitor": "访客",
    },
    "en": {
        "message_title": "New message",
        "message_body": "A visitor sent a new message",
        "message_media": "[Attachment]",
        "assigned_title": "Conversation assigned to you",
        "assigned_body": "Tap to open the conversation",
        "transfer_title": "Conversation transferred to you",
        "transfer_body": "Tap to open the conversation",
        "visitor": "Visitor",
    },
    "ja": {
        "message_title": "新しいメッセージ",
        "message_body": "訪問者から新しいメッセージが届きました",
        "message_media": "[添付ファイル]",
        "assigned_title": "会話が割り当てられました",
        "assigned_body": "タップして会話を開く",
        "transfer_title": "会話が転送されました",
        "transfer_body": "タップして会話を開く",
        "visitor": "訪問者",
    },
}
DEFAULT_LANG = "zh-Hant"


def resolve_lang(locale: str | None) -> str:
    """裝置語系 → 推播文字語言。未提供 → zh-Hant;不支援的語言 → en。"""
    loc = (locale or "").strip().replace("_", "-").lower()
    if not loc:
        return DEFAULT_LANG
    if loc.startswith("zh"):
        parts = loc.split("-")[1:]
        if any(p in ("hans", "cn", "sg", "my") for p in parts):
            return "zh-CN"
        return "zh-Hant"  # zh / zh-TW / zh-HK / zh-MO / zh-Hant
    base = loc.split("-")[0]
    if base == "en":
        return "en"
    if base == "ja":
        return "ja"
    return "en"


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def build_texts(
    kind: str, lang: str, *, preview: bool, visitor_name: str | None, body_text: str | None
) -> tuple[str, str]:
    """依類型 / 語言 / 預覽開關組出 (title, body)。內容已由呼叫端遮罩卡號。"""
    t = _TEXTS.get(lang) or _TEXTS["en"]
    name = _clip(visitor_name or "", _TITLE_MAX) if preview else ""
    if kind == KIND_MESSAGE:
        if not preview:
            return t["message_title"], t["message_body"]
        title = name or t["message_title"]
        body = _clip(body_text or "", _BODY_MAX) or t["message_media"]
        return title, body
    key = "assigned" if kind == KIND_ASSIGNED else "transfer"
    title = t[f"{key}_title"]
    if not preview:
        return title, t[f"{key}_body"]
    parts = [name or t["visitor"]]
    if body_text:
        parts.append(_clip(body_text, _BODY_MAX))
    sep = "：" if lang.startswith("zh") or lang == "ja" else ": "
    return title, _clip(sep.join(parts), _BODY_MAX)


# =========================================================================== #
# FCM HTTP v1
# =========================================================================== #
_token_cache: dict[str, Any] = {"key": None, "token": None, "exp": 0.0}


def _reset_token_cache() -> None:
    _token_cache.update({"key": None, "token": None, "exp": 0.0})


async def _access_token(client: httpx.AsyncClient, sa: dict) -> str | None:
    """取得(快取)FCM access token;失敗回 None。"""
    key = sa.get("client_email")
    now = time.time()
    if (
        _token_cache["token"]
        and _token_cache["key"] == key
        and now < _token_cache["exp"] - TOKEN_REFRESH_MARGIN
    ):
        return _token_cache["token"]
    from jose import jwt  # python-jose(既有依賴)

    claims = {
        "iss": sa["client_email"],
        "scope": FCM_SCOPE,
        "aud": OAUTH_TOKEN_URL,
        "iat": int(now),
        "exp": int(now) + 3600,
    }
    headers = {"kid": sa["private_key_id"]} if isinstance(sa.get("private_key_id"), str) else None
    try:
        assertion = jwt.encode(claims, sa["private_key"], algorithm="RS256", headers=headers)
    except Exception:  # noqa: BLE001 — 私鑰格式錯誤等;不記錄私鑰內容
        logger.warning("FCM 服務帳號 JWT 簽章失敗(private_key 格式?)")
        return None
    try:
        resp = await client.post(
            OAUTH_TOKEN_URL,
            data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("FCM access token 換取失敗:%s", type(exc).__name__)
        return None
    if resp.status_code != 200:
        logger.warning("FCM access token 換取失敗:HTTP %s", resp.status_code)
        return None
    try:
        data = resp.json()
        token = data["access_token"]
        expires_in = float(data.get("expires_in", 3600))
    except (ValueError, KeyError, TypeError):
        logger.warning("FCM access token 回應格式不符")
        return None
    if not isinstance(token, str) or not token:
        return None
    _token_cache.update({"key": key, "token": token, "exp": now + expires_in})
    return token


def build_message(
    token: str, *, title: str, body: str, kind: str, session_id: str, tenant_id: str
) -> dict:
    """組 FCM v1 ``messages:send`` 的 body(data 值必須全為字串)。"""
    return {
        "message": {
            "token": token,
            "notification": {"title": title, "body": body},
            "data": {"type": kind, "session_id": session_id, "tenant_id": tenant_id},
            "android": {
                "priority": "HIGH",
                "notification": {"channel_id": ANDROID_CHANNEL_ID, "tag": session_id},
            },
            "apns": {
                "headers": {"apns-priority": "10", "apns-collapse-id": session_id},
                "payload": {"aps": {"sound": "default", "thread-id": session_id}},
            },
        }
    }


def _error_code(resp: httpx.Response) -> str | None:
    """取 FCM 錯誤碼:優先 details[].errorCode(FcmError),否則 error.status。"""
    try:
        err = resp.json().get("error") or {}
        for d in err.get("details") or []:
            if isinstance(d, dict) and d.get("errorCode"):
                return str(d["errorCode"])
        return str(err.get("status")) if err.get("status") else None
    except Exception:  # noqa: BLE001 — 非 JSON / 形狀不符
        return None


async def _send_one(
    client: httpx.AsyncClient, sa: dict, project_id: str, message: dict
) -> str:
    """送出單則;回 ``"ok"`` / ``"revoke"``(權杖失效)/ ``"error"``。絕不拋錯。"""
    url = FCM_SEND_URL.format(project_id=project_id)
    attempt = 0
    auth_retried = False
    while True:
        access = await _access_token(client, sa)
        if not access:
            return "error"
        try:
            resp = await client.post(
                url, json=message, headers={"Authorization": f"Bearer {access}"}
            )
        except Exception as exc:  # noqa: BLE001 — 連線 / 逾時 / transport 例外一律當可重試錯誤
            status, resp = None, None
            logger.warning("FCM 發送連線失敗:%s", type(exc).__name__)
        else:
            status = resp.status_code
        if status == 200:
            return "ok"
        if resp is not None:
            code = _error_code(resp)
            # 只依 FCM 錯誤碼判定權杖失效(單看 404 可能是 project id 設錯,不可誤撤全部裝置)
            if code == "UNREGISTERED" or (status == 400 and code in _REVOKE_CODES):
                return "revoke"
            if status == 401 and not auth_retried:
                # access token 可能被提前作廢:清快取重換一次(不計入重試次數)
                auth_retried = True
                _reset_token_cache()
                continue
        retryable = status is None or status == 429 or status >= 500
        if not retryable or attempt >= MAX_RETRIES:
            logger.warning("FCM 發送失敗:HTTP %s", status)
            return "error"
        delay = RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)] if RETRY_BACKOFF else 0
        attempt += 1
        if delay > 0:
            await asyncio.sleep(delay)


# =========================================================================== #
# 合併(dedupe)
# =========================================================================== #
def dedupe_key(staff_id: Any, session_id: Any, kind: str) -> str:
    return f"{DEDUPE_PREFIX}{staff_id}:{session_id}:{kind}"


async def _acquire_dedupe(staff_id: Any, session_id: Any, kind: str) -> bool:
    """取得本次推播資格(SET NX EX 15)。Redis 不可用時放行。"""
    try:
        from app.services import realtime

        client = realtime.get_client()
        got = await asyncio.wait_for(
            client.set(dedupe_key(staff_id, session_id, kind), "1", nx=True, ex=DEDUPE_SECONDS),
            timeout=2.0,
        )
    except Exception:  # noqa: BLE001
        logger.warning("推播合併檢查失敗(Redis 不可用?),放行", exc_info=True)
        return True
    if kind != KIND_MESSAGE and got:
        # 指派 / 轉接通知已足以提示這個會話:順手佔住「訊息」名額,避免緊接著再響一次
        # (例:AI 轉人時同一則訪客訊息觸發指派推播後又觸發訊息推播)。
        try:
            await asyncio.wait_for(
                client.set(
                    dedupe_key(staff_id, session_id, KIND_MESSAGE), "1", nx=True, ex=DEDUPE_SECONDS
                ),
                timeout=2.0,
            )
        except Exception:  # noqa: BLE001
            pass
    return bool(got)


# =========================================================================== #
# 背景任務
# =========================================================================== #
_tasks: set[asyncio.Task] = set()


def _spawn(factory: Callable[[], Awaitable[Any]], what: str) -> asyncio.Task | None:
    """未設定 → None;否則以 create_task 背景執行(保留強參照)。絕不拋錯。"""
    try:
        if not is_configured():
            return None
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None  # 沒有執行中的 event loop(同步脈絡)
    except Exception:  # noqa: BLE001
        return None

    async def _guarded() -> None:
        try:
            await factory()
        except Exception:  # noqa: BLE001 — 推播失敗絕不影響主流程
            logger.warning("推播任務失敗(%s)", what, exc_info=True)

    try:
        task = loop.create_task(_guarded())
    except Exception:  # noqa: BLE001
        return None
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return task


async def drain(timeout: float | None = None) -> None:
    """等待目前所有推播任務完成(測試 / 關機用)。"""
    pending = [t for t in list(_tasks) if not t.done()]
    if pending:
        await asyncio.wait(pending, timeout=timeout)


def _as_uuid(value: Any) -> uuid.UUID | None:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


def on_visitor_message(tenant_id: Any, session_id: Any, message_id: Any) -> asyncio.Task | None:
    """新訪客訊息 → 推給會話的負責真人坐席(AI 接待中不推)。commit 後呼叫。"""
    tid, sid, mid = _as_uuid(tenant_id), _as_uuid(session_id), _as_uuid(message_id)
    if tid is None or sid is None:
        return None
    return _spawn(lambda: _run(KIND_MESSAGE, tid, sid, message_id=mid), "message")


def on_assigned(
    tenant_id: Any, session_id: Any, staff_id: Any, actor: Any = "auto"
) -> asyncio.Task | None:
    """會話指派給坐席 → 推給被指派者;操作者就是被指派者(自己認領)時不推。commit 後呼叫。"""
    tid, sid, target = _as_uuid(tenant_id), _as_uuid(session_id), _as_uuid(staff_id)
    if tid is None or sid is None or target is None:
        return None
    if actor is not None and str(actor) == str(target):
        return None
    return _spawn(lambda: _run(KIND_ASSIGNED, tid, sid, target=target), "assigned")


def on_transfer(
    tenant_id: Any, session_id: Any, target_staff_id: Any, actor_staff_id: Any = None, note: str | None = None
) -> asyncio.Task | None:
    """會話轉接給坐席 → 推給目標;轉給自己不推。commit 後呼叫。"""
    tid, sid, target = _as_uuid(tenant_id), _as_uuid(session_id), _as_uuid(target_staff_id)
    if tid is None or sid is None or target is None:
        return None
    if actor_staff_id is not None and str(actor_staff_id) == str(target):
        return None
    return _spawn(lambda: _run(KIND_TRANSFER, tid, sid, target=target, note=note), "transfer")


# =========================================================================== #
# 任務本體
# =========================================================================== #
async def _staff_eligible(db, tenant_id: uuid.UUID, staff_id: uuid.UUID) -> bool:
    """坐席啟用、未軟刪、同租戶,且租戶啟用(與 deps 即時撤銷邏輯一致)。"""
    from sqlalchemy import select

    from app.models.iam import Staff
    from app.models.tenancy import Tenant

    row = (
        await db.execute(
            select(Staff.is_active, Staff.deleted_at, Staff.tenant_id, Tenant.is_active)
            .outerjoin(Tenant, Tenant.id == Staff.tenant_id)
            .where(Staff.id == staff_id)
        )
    ).first()
    if row is None:
        return False
    staff_active, staff_deleted_at, staff_tenant, tenant_active = row
    return bool(
        staff_active and staff_deleted_at is None and staff_tenant == tenant_id and tenant_active
    )


async def _run(
    kind: str,
    tenant_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    message_id: uuid.UUID | None = None,
    target: uuid.UUID | None = None,
    note: str | None = None,
) -> dict:
    """判斷並送出一則推播。回傳摘要(供測試檢視)。"""
    from sqlalchemy import select

    from app.models.conversation import Message, Session
    from app.models.device import PUSH_PLATFORMS, DeviceToken
    from app.models.visitor import Visitor
    from app.services import presence
    from app.services.conversation import activity_preview, mask_card_numbers

    sa = _service_account()
    project_id = _project_id(sa) if sa else None
    if not sa or not project_id:
        return {"status": "skipped", "reason": "not_configured"}

    async with _open_session() as db:
        session = (
            await db.execute(
                select(Session).where(
                    Session.id == session_id,
                    Session.tenant_id == tenant_id,
                    Session.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if session is None or session.status == "closed":
            return {"status": "skipped", "reason": "session"}

        body_text: str | None = None
        if kind == KIND_MESSAGE:
            if session.handler_type != "human" or session.handler_staff_id is None:
                return {"status": "skipped", "reason": "not_human"}
            staff_id = session.handler_staff_id
            if message_id is not None:
                msg = (
                    await db.execute(
                        select(Message).where(
                            Message.id == message_id,
                            Message.session_id == session_id,
                            Message.tenant_id == tenant_id,
                        )
                    )
                ).scalar_one_or_none()
                if msg is None or msg.sender_type != "visitor":
                    return {"status": "skipped", "reason": "message"}
                # add_message 已遮罩卡號;再遮一次為縱深防禦
                body_text = activity_preview(mask_card_numbers(msg.content or ""), msg.content_type)
        else:
            staff_id = target
            if session.handler_staff_id != staff_id:
                return {"status": "skipped", "reason": "not_handler"}
            if note:
                body_text = mask_card_numbers(note)

        if not await _staff_eligible(db, tenant_id, staff_id):
            return {"status": "skipped", "reason": "staff_inactive"}

        devices = list(
            (
                await db.execute(
                    select(DeviceToken).where(
                        DeviceToken.tenant_id == tenant_id,
                        DeviceToken.staff_id == staff_id,
                        DeviceToken.revoked_at.is_(None),
                        DeviceToken.deleted_at.is_(None),
                        DeviceToken.platform.in_(PUSH_PLATFORMS),
                    )
                )
            )
            .scalars()
            .all()
        )
        if not devices:
            return {"status": "skipped", "reason": "no_devices"}

        if await presence.is_foreground(staff_id):
            return {"status": "skipped", "reason": "foreground"}
        if not await _acquire_dedupe(staff_id, session_id, kind):
            return {"status": "skipped", "reason": "dedupe"}

        visitor_name: str | None = None
        preview = preview_enabled()
        if preview and session.visitor_id is not None:
            visitor_name = (
                await db.execute(
                    select(Visitor.display_name).where(
                        Visitor.id == session.visitor_id, Visitor.tenant_id == tenant_id
                    )
                )
            ).scalar_one_or_none()
            if visitor_name:
                visitor_name = mask_card_numbers(visitor_name)

        sent = revoked = failed = 0
        async with httpx.AsyncClient(transport=_transport, timeout=HTTP_TIMEOUT_SECONDS) as client:
            for dev in devices:
                title, body = build_texts(
                    kind,
                    resolve_lang(dev.locale),
                    preview=preview,
                    visitor_name=visitor_name,
                    body_text=body_text,
                )
                message = build_message(
                    dev.token,
                    title=title,
                    body=body,
                    kind=kind,
                    session_id=str(session_id),
                    tenant_id=str(tenant_id),
                )
                result = await _send_one(client, sa, project_id, message)
                if result == "ok":
                    sent += 1
                elif result == "revoke":
                    revoked += 1
                    dev.revoked_at = datetime.now(UTC)
                    logger.info("FCM 權杖失效,已撤銷裝置 device=%s", dev.id)
                else:
                    failed += 1
        if revoked:
            await db.commit()
    return {"status": "sent", "sent": sent, "revoked": revoked, "failed": failed}
