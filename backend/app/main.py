"""kefu backend entrypoint. Registers all module routers (M1–M12)."""
from __future__ import annotations

from contextlib import asynccontextmanager
from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException

import asyncio
import logging
import re
import uuid

from app.api.v1 import (
    ai,
    apikeys,
    attachments,
    audit,
    auth,
    automation,
    billing,
    branding,
    canned,
    channel,
    company,
    conversation,
    ext,
    exports,
    fields,
    goals,
    helpcenter,
    collab,
    iam,
    integrations,
    knowledge,
    macros,
    onboarding,
    platform,
    playground,
    public_info,
    proactive,
    quality,
    reporting,
    routing,
    saml,
    scheduling,
    scim,
    search,
    settings as settings_api,
    sla,
    tenancy,
    ticket,
    visitor,
    webhooks,
    workflows,
)
from app.core.config import settings
from app.core.db import SessionLocal, init_db
from app.core.response import err, ok, reset_request_id, set_request_id

logger = logging.getLogger("kefu.scheduler")
_err_logger = logging.getLogger("kefu.error")

# 分散式排程鎖:多副本(多個 backend 容器)時,只有持鎖者跑 SLA/Email,
# 避免每副本各跑一次造成重複收信、重複 SLA 動作。TTL 略大於一輪間隔,
# 持鎖者每輪續租;副本掛掉後鎖自然過期,其他副本接手成為 leader。
_SCHED_LOCK_KEY = "kefu:scheduler:leader"
_SCHED_INTERVAL = 60  # 每輪秒數
_SCHED_LOCK_TTL = 90  # 鎖存活秒數(> 一輪,留續租餘裕)
# 「持鎖者才刪/續租」的 CAS Lua:值相符才動作,避免誤刪別人的鎖。
_RENEW_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"


async def _acquire_or_renew_leader(client, token: str) -> bool:
    """嘗試成為 / 續任排程 leader。回傳 True 表示本副本本輪應執行排程。

    Redis 不可用時保守回傳 True(退化為單副本行為:寧可重複跑,不要漏跑)。
    """
    try:
        got = await client.set(_SCHED_LOCK_KEY, token, nx=True, ex=_SCHED_LOCK_TTL)
        if got:
            return True
        # 非新取得:若本副本已是 leader 則原子續租(CAS)
        renewed = await client.eval(_RENEW_LUA, 1, _SCHED_LOCK_KEY, token, str(_SCHED_LOCK_TTL * 1000))
        return bool(renewed)
    except Exception:
        logger.warning("排程鎖 Redis 不可用,退化為本副本直接執行", exc_info=True)
        return True


async def _scheduler_loop():
    """背景排程器:定時跑 SLA 掃描與 Email 收信(各自降級,不互相影響)。

    多副本部署下經 Redis 鎖選出單一 leader 執行,避免重複。
    """
    from app.services import sla as sla_service
    from app.services import realtime
    from app.workers.jobs import run_due_jobs

    try:
        from app.services.email import poll_email
    except Exception:  # pragma: no cover - email 模組缺失時降級
        poll_email = None

    token = f"{uuid.uuid4()}"  # 本副本身分,用於 CAS 續租

    while True:
        try:
            client = realtime.get_client()
            is_leader = await _acquire_or_renew_leader(client, token)
        except Exception:
            is_leader = True  # 取鎖流程本身異常也退化為執行

        if is_leader:
            try:
                async with SessionLocal() as db:
                    await sla_service.scan(db)
                    await db.commit()
            except Exception:
                logger.exception("SLA 掃描失敗")
            if poll_email is not None:
                try:
                    async with SessionLocal() as db:
                        await poll_email(db)
                except Exception:
                    logger.exception("Email 收信失敗")
            # 背景 worker(snooze 喚醒、CSAT 邀評、SLA 摘要、爬取入庫等的載體);
            # run_due_jobs 內部對每個 worker 做 savepoint 隔離,單一失敗不拖垮其他。
            try:
                async with SessionLocal() as db:
                    await run_due_jobs(db)
                    await db.commit()
            except Exception:
                logger.exception("背景 worker 執行失敗")
            # 排程 / 訂閱式報表:到期者產出並寄出(內部 savepoint 隔離)。
            try:
                from app.api.v1.reporting import run_due_report_schedules
                async with SessionLocal() as db:
                    await run_due_report_schedules(db)
                    await db.commit()
            except Exception:
                logger.exception("排程報表執行失敗")
        await asyncio.sleep(_SCHED_INTERVAL)  # 每 60 秒一輪


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.assert_secrets_safe()  # 正式環境:預設/弱 JWT 金鑰 fail-closed 拒啟
    await init_db()  # dev bootstrap: pgvector + create tables
    task = asyncio.create_task(_scheduler_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title=f"{settings.app_name} API", version="0.1.0", lifespan=lifespan)

# 原生 App 的固定 origin(docs/NATIVE-CLIENTS.md §2;上線後不可改):
# macOS tauri://localhost、Windows http(s)://tauri.localhost、iOS capacitor://localhost、
# Android https://localhost(另含 http://localhost 供開發)。完整比對(fullmatch + ^$),
# 不放任意 port、不做前綴比對。
NATIVE_ORIGIN_REGEX = r"^(tauri://localhost|https?://tauri\.localhost|capacitor://localhost|https?://localhost)$"


def build_cors_options(cfg=settings) -> dict:
    """依設定組 CORSMiddleware 參數(抽出為函式以便測試)。

    - ``KEFU_CORS_ORIGINS``:逗號分隔白名單,或 "*" 全開(widget 跨網域嵌入需要,預設全開)。
    - 白名單模式自動併入原生 origin(NATIVE_ORIGIN_REGEX),與 ``KEFU_CORS_ORIGIN_REGEX`` 以 | 合併。
    - ``allow_credentials`` 恆為 False:全站只用 Bearer、不用 cookie,不需要憑證模式
      (也避免白名單模式意外開啟 credentials)。
    - ``expose_headers``:X-Request-Id(錯誤追蹤)、Content-Disposition(下載檔名)。
    """
    origins = [o.strip() for o in (cfg.cors_origins or "").split(",") if o.strip()] or ["*"]
    allow_all = "*" in origins
    custom_regex = (cfg.cors_origin_regex or "").strip() or None
    if allow_all:
        regex = custom_regex
    elif custom_regex:
        regex = f"(?:{NATIVE_ORIGIN_REGEX})|(?:{custom_regex})"
    else:
        regex = NATIVE_ORIGIN_REGEX
    expose = [h.strip() for h in (cfg.cors_expose_headers or "").split(",") if h.strip()]
    return {
        "allow_origins": ["*"] if allow_all else origins,
        "allow_origin_regex": regex,
        "allow_credentials": False,
        "allow_methods": ["*"],
        "allow_headers": ["*"],
        "expose_headers": expose,
    }


_cors_options = build_cors_options()
_cors_regex = re.compile(_cors_options["allow_origin_regex"]) if _cors_options["allow_origin_regex"] else None


def _cors_headers_for(request: Request) -> dict[str, str]:
    """最外層保底 500 用:依請求 Origin 補 CORS 標頭(與 CORSMiddleware 同一判定規則)。"""
    origin = request.headers.get("origin")
    if not origin:
        return {}
    allowed = "*" in _cors_options["allow_origins"] or origin in _cors_options["allow_origins"]
    if not allowed and _cors_regex is not None and _cors_regex.fullmatch(origin):
        allowed = True
    if not allowed:
        return {}
    hdrs = {"Access-Control-Allow-Origin": "*" if "*" in _cors_options["allow_origins"] else origin}
    if hdrs["Access-Control-Allow-Origin"] != "*":
        hdrs["Vary"] = "Origin"
    if _cors_options["expose_headers"]:
        hdrs["Access-Control-Expose-Headers"] = ", ".join(_cors_options["expose_headers"])
    return hdrs


class CatchAllErrorMiddleware:
    """純 ASGI 保底:在 CORSMiddleware **內層**攔住未捕獲例外,回 500 統一信封。

    Starlette 的 ``exception_handler(Exception)`` 由最外層 ServerErrorMiddleware 執行,
    其回應不經 CORSMiddleware → 跨源請求只看到「Failed to fetch」,讀不到錯誤信封與
    request_id。本 middleware 先於 CORSMiddleware 註冊(= 位於其內層),使 500 回應也
    經 CORS 加上標頭。回應已開始送出時無法改寫,只能續拋交給外層處理。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = False

        async def send_wrapper(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            if started:
                raise
            request_id = (scope.get("state") or {}).get("request_id")
            _err_logger.exception(
                "未捕獲例外 request_id=%s path=%s", request_id, scope.get("path")
            )
            response = _envelope_response(
                500, err("internal_error", "伺服器內部錯誤", request_id), request_id
            )
            await response(scope, receive, send)


# 註冊順序 = 由內而外:CatchAll 必須先於 CORS 註冊,才會位於 CORS 內層。
app.add_middleware(CatchAllErrorMiddleware)
app.add_middleware(CORSMiddleware, **_cors_options)

# 稽核日誌:對變更型請求(2xx)記錄操作者/動作/目標(不讀 body,失敗降級)
from app.services.audit import AuditMiddleware  # noqa: E402

app.add_middleware(AuditMiddleware)


# ---------------------------------------------------------------------------
# 統一錯誤信封 + 請求關聯 ID(request_id)
#
# 問題:FastAPI 原生錯誤(422 參數驗證、401/403/404 HTTPException、未捕獲 500)
# 不走專案的 {ok,data,error,request_id} 信封,且回應的 request_id 恆為 null,
# 無法追蹤。以下用「一個 middleware + 三個全域例外處理器」統一收斂,不改動
# 既有已回信封的端點行為(只包裝原生 FastAPI 錯誤)。
#
# request_id 實作:純 ASGI middleware(非 BaseHTTPMiddleware),與端點在同一
# 執行 context,故其設定的 contextvar 能正確傳遞給下游端點與例外處理器。
#   - 每請求生成 uuid4 hex 作為 request_id;
#   - 寫入 request.state.request_id(例外處理器可直接取用,連 500 亦可);
#   - 設進 response.py 的 contextvar,使 ok()/err() 未顯式帶 id 時自動回填,
#     因此無需改動任何既有端點的 ok()/err() 呼叫;
#   - 於回應標頭 X-Request-Id 回傳。
# ---------------------------------------------------------------------------


class RequestIDMiddleware:
    """為每個 HTTP 請求生成 request_id,供信封回填並在 X-Request-Id 標頭回傳。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = uuid.uuid4().hex
        # request.state 讀取的是 scope["state"];setdefault 以免蓋掉 lifespan state
        scope.setdefault("state", {})["request_id"] = request_id
        token = set_request_id(request_id)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["X-Request-Id"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            reset_request_id(token)


# 最後註冊 = 最外層 middleware:確保 X-Request-Id 套用於所有回應(含 CORS/稽核
# 之後的最終回應),且 contextvar 在其餘處理前就緒。
app.add_middleware(RequestIDMiddleware)


# HTTP 狀態碼 → 穩定 error code(前端可依 code 在地化,不依賴訊息文字)
_HTTP_STATUS_CODE: dict[int, str] = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    410: "gone",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "unprocessable_entity",
    429: "rate_limited",
    500: "internal_error",
    502: "bad_gateway",
    503: "service_unavailable",
    504: "gateway_timeout",
}


def _code_for_status(status_code: int) -> str:
    return _HTTP_STATUS_CODE.get(status_code, f"http_{status_code}")


def _envelope_response(status_code: int, body: dict, request_id: str | None, headers=None) -> JSONResponse:
    """產生帶信封的 JSONResponse,並保證 X-Request-Id 標頭一致(涵蓋 500:
    其回應由最外層 ServerErrorMiddleware 送出,不經本 middleware 的標頭注入)。"""
    hdrs = dict(headers or {})
    if request_id:
        hdrs["X-Request-Id"] = request_id
    return JSONResponse(status_code=status_code, content=body, headers=hdrs)


@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """422 參數驗證:轉為統一信封,原始 errors 摘要放進 error.details。"""
    request_id = getattr(request.state, "request_id", None)
    raw_errors = exc.errors()
    # 可讀摘要:欄位路徑 + 訊息,取前數則,避免訊息過長
    parts = []
    for e in raw_errors[:5]:
        loc = ".".join(str(x) for x in e.get("loc", []) if x != "body") or "(body)"
        parts.append(f"{loc}: {e.get('msg', '')}".strip())
    message = "請求參數驗證失敗" + ("(" + "；".join(parts) + ")" if parts else "")
    body = err("VALIDATION_ERROR", message, request_id)
    # jsonable_encoder:errors() 可能含非 JSON 型別(如 ValueError),需安全序列化
    body["error"]["details"] = jsonable_encoder(raw_errors)
    return _envelope_response(422, body, request_id)


@app.exception_handler(StarletteHTTPException)
async def _http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """401/403/404/… HTTPException:轉為統一信封並保留原 status_code。

    detail 為字串 → message;為 dict(可能含 code/message)→ 沿用其 code/message。
    code 未指定時用狀態碼對應的穩定 code。保留原 exc.headers(如 401 的
    WWW-Authenticate、405 的 Allow)。
    """
    request_id = getattr(request.state, "request_id", None)
    status_code = exc.status_code
    default_code = _code_for_status(status_code)
    detail = exc.detail

    if isinstance(detail, dict):
        code = detail.get("code") or default_code
        message = detail.get("message") or detail.get("msg") or HTTPStatus(status_code).phrase
    elif isinstance(detail, str) and detail:
        code = default_code
        message = detail
    else:
        code = default_code
        try:
            message = HTTPStatus(status_code).phrase
        except ValueError:
            message = default_code

    return _envelope_response(
        status_code, err(code, message, request_id), request_id, headers=getattr(exc, "headers", None)
    )


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """保底 500:未捕獲例外(如 DB IntegrityError)回統一信封,不洩漏堆疊,記 log。

    註:此處理器由最外層 ServerErrorMiddleware 執行(在 RequestIDMiddleware 之外),
    故 request_id 從 request.state 取得,並顯式帶上 X-Request-Id 標頭。
    一般端點的例外已由 CORS 內層的 CatchAllErrorMiddleware 收斂;能走到這裡的多半是
    外層 middleware 自身的例外,其回應不經 CORSMiddleware,故依 Origin 自行補 CORS 標頭。
    """
    request_id = getattr(request.state, "request_id", None)
    _err_logger.exception("未捕獲例外 request_id=%s path=%s", request_id, request.url.path)
    return _envelope_response(
        500,
        err("internal_error", "伺服器內部錯誤", request_id),
        request_id,
        headers=_cors_headers_for(request),
    )


@app.get("/health")
async def health() -> dict:
    return ok({"status": "up", "env": settings.environment})


# --- auth (foundation) ---
app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])

# --- modules M1–M12 ---
app.include_router(tenancy.router, prefix="/api/v1/tenancy", tags=["tenancy"])
app.include_router(iam.router, prefix="/api/v1/iam", tags=["iam"])
app.include_router(conversation.router, prefix="/api/v1/conversation", tags=["conversation"])
app.include_router(conversation.ws_router)  # /ws/agent, /ws/widget (no prefix)
app.include_router(channel.router, prefix="/api/v1/channel", tags=["channel"])
app.include_router(visitor.router, prefix="/api/v1/visitor", tags=["visitor"])
app.include_router(company.router, prefix="/api/v1/company", tags=["company"])
app.include_router(knowledge.router, prefix="/api/v1/knowledge", tags=["knowledge"])
app.include_router(integrations.router, prefix="/api/v1/integrations", tags=["integrations"])
app.include_router(saml.router, prefix="/api/v1/saml", tags=["saml"])
app.include_router(scim.router, prefix="/api/v1/scim/v2", tags=["scim"])
app.include_router(ai.router, prefix="/api/v1/ai", tags=["ai"])
app.include_router(onboarding.router, prefix="/api/v1/onboarding", tags=["onboarding"])
app.include_router(scheduling.router, prefix="/api/v1/scheduling", tags=["scheduling"])
app.include_router(goals.router, prefix="/api/v1/goals", tags=["goals"])
app.include_router(routing.router, prefix="/api/v1/routing", tags=["routing"])
app.include_router(ticket.router, prefix="/api/v1/ticket", tags=["ticket"])
app.include_router(quality.router, prefix="/api/v1/quality", tags=["quality"])
app.include_router(reporting.router, prefix="/api/v1/reporting", tags=["reporting"])
app.include_router(billing.router, prefix="/api/v1/billing", tags=["billing"])
app.include_router(canned.router, prefix="/api/v1/canned", tags=["canned"])
app.include_router(search.router, prefix="/api/v1/search", tags=["search"])
app.include_router(settings_api.router, prefix="/api/v1/settings", tags=["settings"])
app.include_router(automation.router, prefix="/api/v1/automation", tags=["automation"])
app.include_router(sla.router, prefix="/api/v1/sla", tags=["sla"])
app.include_router(proactive.router, prefix="/api/v1/proactive", tags=["proactive"])
app.include_router(helpcenter.router, prefix="/api/v1/helpcenter", tags=["helpcenter"])
app.include_router(webhooks.router, prefix="/api/v1/webhooks", tags=["webhooks"])
app.include_router(apikeys.router, prefix="/api/v1/apikeys", tags=["apikeys"])
app.include_router(attachments.router, prefix="/api/v1/attachments", tags=["attachments"])
app.include_router(exports.router, prefix="/api/v1/exports", tags=["exports"])
app.include_router(macros.router, prefix="/api/v1/macros", tags=["macros"])
app.include_router(fields.router, prefix="/api/v1/fields", tags=["fields"])
app.include_router(collab.router, prefix="/api/v1/collab", tags=["collab"])
app.include_router(playground.router, prefix="/api/v1/playground", tags=["playground"])
app.include_router(workflows.router, prefix="/api/v1/workflows", tags=["workflows"])
app.include_router(audit.router, prefix="/api/v1/audit", tags=["audit"])
app.include_router(ext.router, prefix="/api/ext/v1", tags=["ext"])
app.include_router(platform.router, prefix="/api/v1/platform", tags=["platform"])
app.include_router(branding.public_router, prefix="/api/v1/public", tags=["branding"])
app.include_router(public_info.router, prefix="/api/v1/public", tags=["public"])
app.include_router(branding.router, prefix="/api/v1/branding", tags=["branding"])

# 原生 App 裝置推播權杖登記(docs/NATIVE-CLIENTS.md §4.1)
from app.api.v1 import devices  # noqa: E402

app.include_router(devices.router, prefix="/api/v1/devices", tags=["devices"])
