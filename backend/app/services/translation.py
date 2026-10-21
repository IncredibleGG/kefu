"""雙向即時翻譯服務(M6 週邊)—— 可插拔翻譯供應商。

對外兩個函式,供「渠道入站(訪客原文→坐席語言)」與「坐席出站(坐席原文→訪客語言)」共用:

    async def translate(text, target_lang, source_lang=None, *, backend=None, backend_config=None)
        -> {"text": 譯文, "source_lang": 來源語言代碼}
    async def detect_lang(text, *, backend=None, backend_config=None) -> str   # BCP-47,失敗回 "unknown"

供應商(backend)可插拔,預設 **google(免 key、零成本)**:
  - ``google``  預設:Google 翻譯公開端點(translate_a/single),用 httpx GET,免金鑰。
  - ``ours``    付費進階:用現有 LLM(get_provider,gpt-5.5)翻譯。
  - ``custom``  付費:呼叫客戶自訂翻譯 API(端點 / key 由設定提供)。

供應商設定讀租戶層級(``Tenant.llm_config["translation"]``,見 ``resolve_backend``),
預設 google。付費 gating(套餐 / 計費)由計費模組另行控管,本檔只留好抽象。

**降級原則**:任何失敗(逾時、空回覆、供應商未就緒)都不向上拋——translate 回原文、
detect_lang 回 "unknown"。翻譯是加值層,絕不該拖垮訊息流。
"""
from __future__ import annotations

import asyncio
import logging

import httpx
from sqlalchemy import select

from app.core import crypto
from app.core.config import settings
from app.services.llm.base import ChatMessage, get_provider

logger = logging.getLogger("kefu.translation")

DEFAULT_BACKEND = "google"
_GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single"

# 常見語言代碼 → 人類可讀名(僅供 LLM 提示詞更精準,未列者直接用代碼)
_LANG_NAMES: dict[str, str] = {
    "zh-Hant": "繁體中文",
    "zh-Hans": "簡體中文",
    "zh": "中文",
    "en": "英文",
    "ja": "日文",
    "ko": "韓文",
    "es": "西班牙文",
    "fr": "法文",
    "de": "德文",
    "ru": "俄文",
    "th": "泰文",
    "vi": "越南文",
    "id": "印尼文",
    "pt": "葡萄牙文",
    "it": "義大利文",
    "ar": "阿拉伯文",
}

# 我方 BCP-47 ⇄ Google 語言代碼(主要處理中文繁簡)
_TO_GOOGLE = {"zh-Hant": "zh-TW", "zh-Hans": "zh-CN", "zh": "zh-CN"}
_FROM_GOOGLE = {"zh-TW": "zh-Hant", "zh-CN": "zh-Hans", "zh-cn": "zh-Hans", "zh-tw": "zh-Hant"}

_STRIP_WRAPPERS = ('"', "'", "「", "」", "『", "』", "“", "”")


def _lang_name(code: str | None) -> str:
    if not code:
        return "目標語言"
    return _LANG_NAMES.get(code, code)


def _to_google_lang(code: str | None) -> str:
    if not code or code == "unknown":
        return "auto"
    return _TO_GOOGLE.get(code, code)


def _from_google_lang(code: str | None) -> str:
    if not code:
        return "unknown"
    return _FROM_GOOGLE.get(code, code)


def _clean(text: str) -> str:
    """清掉 LLM 常見的多餘首尾引號 / 空白。"""
    out = (text or "").strip()
    for q in _STRIP_WRAPPERS:
        if len(out) >= 2 and out.startswith(q) and out.endswith(q):
            out = out[1:-1].strip()
            break
    return out


async def resolve_backend(db, tenant_id) -> tuple[str, dict]:
    """讀租戶翻譯供應商設定,回 (backend, config);預設 google。

    設定位置:``Tenant.llm_config["translation"]``(不改 tenancy 模組,只讀)。
    例:``{"translation": {"provider": "google"}}`` 或
    ``{"translation": {"provider": "custom", "endpoint": "...", "api_key": "..."}}``。
    讀取失敗一律回預設 google。
    """
    try:
        from app.models.tenancy import Tenant

        tenant = (
            await db.execute(select(Tenant).where(Tenant.id == tenant_id))
        ).scalar_one_or_none()
        cfg: dict = {}
        if tenant and getattr(tenant, "llm_config", None):
            cfg = dict(tenant.llm_config).get("translation") or {}
        backend = cfg.get("provider") or cfg.get("backend") or DEFAULT_BACKEND
        return backend, cfg
    except Exception:
        return DEFAULT_BACKEND, {}


# --------------------------------------------------------------------------- #
# 對外主函式
# --------------------------------------------------------------------------- #
async def translate(
    text: str,
    target_lang: str,
    source_lang: str | None = None,
    *,
    backend: str | None = None,
    backend_config: dict | None = None,
) -> dict:
    """把 ``text`` 翻成 ``target_lang``,依 backend 選供應商(預設 google)。

    回 ``{"text": 譯文, "source_lang": 來源語言代碼}``;失敗降級回原文。
    """
    original = text or ""
    if not original.strip():
        return {"text": original, "source_lang": source_lang or "unknown"}

    backend = backend or DEFAULT_BACKEND
    cfg = backend_config or {}
    try:
        if backend == "ours":
            return await _llm_translate(original, target_lang, source_lang)
        if backend == "custom":
            return await _custom_translate(original, target_lang, source_lang, cfg)
        # google(預設)與未知 backend 一律走免費端點
        return await _google_translate(original, target_lang, source_lang)
    except Exception:
        logger.warning("翻譯 backend=%s 失敗(target=%s),嘗試 LLM 退路", backend, target_lang)
        # google/custom 失敗(如免費端點被限流)→ 自動退回 LLM,確保翻譯仍可用
        if backend != "ours":
            try:
                out = await _llm_translate(original, target_lang, source_lang)
                logger.info("翻譯已由 LLM 退路完成(原 backend=%s)", backend)
                return out
            except Exception:
                logger.warning("LLM 翻譯退路亦失敗,降級回原文", exc_info=True)
        return {"text": original, "source_lang": source_lang or "unknown"}


async def detect_lang(
    text: str,
    *,
    backend: str | None = None,
    backend_config: dict | None = None,
) -> str:
    """偵測文字主要語言,回 BCP-47 代碼;無法判斷回 "unknown"。"""
    sample = (text or "").strip()
    if not sample:
        return "unknown"
    sample = sample[:500]

    backend = backend or DEFAULT_BACKEND
    try:
        if backend == "ours":
            return await _llm_detect(sample)
        # google / custom / 未知:用 google 偵測(免費、準)
        return await _google_detect(sample)
    except Exception:
        logger.warning("語言偵測失敗,回 unknown(backend=%s)", backend, exc_info=True)
        return "unknown"


# --------------------------------------------------------------------------- #
# backend: google(預設,免 key)
# --------------------------------------------------------------------------- #
async def _google_call(text: str, target_lang: str, source_lang: str | None) -> list:
    params = {
        "client": "gtx",
        "sl": _to_google_lang(source_lang),
        "tl": _to_google_lang(target_lang),
        "dt": "t",
        "q": text,
    }
    # 帶瀏覽器 User-Agent 可大幅降低免費端點 429 限流;429/5xx 時退避重試。
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        )
    }
    last_exc: Exception | None = None
    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as c:
        for attempt in range(3):
            try:
                r = await c.get(_GOOGLE_ENDPOINT, params=params, headers=headers)
                if r.status_code in (429, 500, 502, 503):
                    last_exc = httpx.HTTPStatusError(
                        f"google translate {r.status_code}", request=r.request, response=r
                    )
                    await asyncio.sleep(0.4 * (attempt + 1))
                    continue
                r.raise_for_status()
                return r.json()
            except (httpx.TransportError, httpx.HTTPStatusError) as e:
                last_exc = e
                await asyncio.sleep(0.4 * (attempt + 1))
    raise last_exc if last_exc else RuntimeError("google translate failed")


async def _google_translate(text: str, target_lang: str, source_lang: str | None) -> dict:
    data = await _google_call(text, target_lang, source_lang)
    # data[0] 為分段譯文:每段 seg[0] 串接;data[2] 為偵測到的來源語言
    segments = "".join(
        seg[0] for seg in (data[0] or []) if seg and seg[0]
    ) if data and data[0] else ""
    translated = segments.strip() or text
    detected = data[2] if len(data) > 2 else None
    resolved_source = _from_google_lang(detected) if detected else (source_lang or "unknown")
    return {"text": translated, "source_lang": resolved_source}


async def _google_detect(text: str) -> str:
    # 借翻譯端點回傳的 data[2] 取偵測語言(目標語言隨意)
    data = await _google_call(text, "en", None)
    detected = data[2] if len(data) > 2 else None
    return _from_google_lang(detected) if detected else "unknown"


# --------------------------------------------------------------------------- #
# backend: ours(付費,LLM)
# --------------------------------------------------------------------------- #
def _provider():
    return get_provider(settings.default_llm_provider, settings.openai_api_key)


async def _llm_translate(text: str, target_lang: str, source_lang: str | None) -> dict:
    sys_parts = [
        f"你是專業的即時翻譯引擎。請把使用者提供的文字翻譯成「{_lang_name(target_lang)}」"
        f"({target_lang})。",
        "規則:只輸出翻譯後的文字本身,不要加任何前綴、引號、解釋或原文;",
        "保留原有的換行、emoji、網址與專有名詞;若原文已是目標語言,原樣輸出即可。",
    ]
    if source_lang and source_lang != "unknown":
        sys_parts.append(f"原文語言為「{_lang_name(source_lang)}」({source_lang})。")
    messages = [
        ChatMessage(role="system", content="".join(sys_parts)),
        ChatMessage(role="user", content=text),
    ]
    raw = await _provider().chat(messages, model=settings.default_llm_model, temperature=0)
    translated = _clean(raw)
    if not translated:
        raise ValueError("空翻譯結果")
    return {"text": translated, "source_lang": source_lang or "unknown"}


async def _llm_detect(text: str) -> str:
    messages = [
        ChatMessage(
            role="system",
            content=(
                "你是語言偵測器。判斷使用者文字的主要語言,只輸出一個 BCP-47 語言代碼"
                "(例:zh-Hant、zh-Hans、en、ja、ko),不要輸出任何其他文字或標點。"
                "中文請務必區分 zh-Hant(繁體)與 zh-Hans(簡體)。"
            ),
        ),
        ChatMessage(role="user", content=text),
    ]
    raw = await _provider().chat(messages, model=settings.default_llm_model, temperature=0)
    code = (raw or "").strip().split()[0].strip(".,;:「」\"'`") if (raw or "").strip() else ""
    return code or "unknown"


# --------------------------------------------------------------------------- #
# backend: custom(付費,客戶自訂 API)
# --------------------------------------------------------------------------- #
async def _custom_translate(
    text: str, target_lang: str, source_lang: str | None, cfg: dict
) -> dict:
    """呼叫客戶自訂翻譯 API。

    設定:``{"endpoint": "https://...", "api_key": "...", "method": "POST"}``。
    送 ``{text, target_lang, source_lang}``;接受回應中的 text/translated_text 與
    source_lang/detected_lang。端點未設定則丟出(由 translate 降級回原文)。
    """
    endpoint = cfg.get("endpoint")
    if not endpoint:
        raise ValueError("custom 翻譯供應商未設定 endpoint")
    headers = {"Content-Type": "application/json"}
    # api_key 於 Tenant.llm_config 靜態加密,呼叫外部端點前解密(舊明文相容)。
    api_key = crypto.decrypt(cfg.get("api_key"))
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {"text": text, "target_lang": target_lang, "source_lang": source_lang}
    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as c:
        r = await c.post(endpoint, json=payload, headers=headers)
        r.raise_for_status()
        data = r.json()
    translated = data.get("text") or data.get("translated_text") or text
    detected = data.get("source_lang") or data.get("detected_lang") or source_lang or "unknown"
    return {"text": translated, "source_lang": detected}
