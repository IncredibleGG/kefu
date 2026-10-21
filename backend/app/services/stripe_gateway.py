"""Stripe 收款閘道(計費整合首版,測試模式)。

以 httpx 直接呼叫 Stripe REST API(``https://api.stripe.com/v1/...``,Bearer=secret key),
**不引入 stripe SDK** 以免相依。金鑰一律由 settings / 環境變數讀取,絕不寫死;
未設定金鑰時 ``is_enabled()`` 回 False,呼叫端據此回明確訊息並降級,不崩。

金鑰來源(依序):
- Secret key:``getattr(settings, "stripe_secret_key", None)`` → 環境變數 ``KEFU_STRIPE_SECRET_KEY``。
- Webhook 簽章密鑰:``getattr(settings, "stripe_webhook_secret", None)`` → ``KEFU_STRIPE_WEBHOOK_SECRET``。

測試模式:使用者放測試金鑰(``sk_test_...`` / ``whsec_...``)即為測試模式;本程式不區分
正式 / 測試,由金鑰本身決定,故**絕不會發起真實扣款**(卡號輸入全在 Stripe 託管結帳頁)。

對外函式:
- ``is_enabled()`` / ``webhook_enabled()``:金鑰是否就緒。
- ``create_checkout_session(...)``:建立訂閱型 Checkout Session,回 hosted url + session id。
- ``verify_webhook(payload, sig_header, secret)``:驗 Stripe-Signature 簽章,回事件 dict 或 None。
- ``handle_event(event)``:把 Stripe 事件正規化成「本地 Subscription 該如何更新」的指令 dict
  (純函式,不碰 DB;實際落庫由 billing.py 端點負責)。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
from typing import Any

import httpx

from app.core.config import settings

logger = logging.getLogger("kefu.stripe")

STRIPE_API_BASE = "https://api.stripe.com/v1"
_TIMEOUT = 20.0
# Stripe-Signature 時間戳容許誤差(秒);超過視為重放,拒收。
_SIG_TOLERANCE = 300

# Stripe 訂閱狀態 → 本地 Subscription.status(見 models/billing.py 註解)
_STATUS_MAP = {
    "active": "active",
    "trialing": "trialing",
    "past_due": "past_due",
    "unpaid": "past_due",
    "canceled": "canceled",
    "incomplete": "past_due",
    "incomplete_expired": "canceled",
}


# --------------------------------------------------------------------------- #
# 金鑰讀取與啟用判斷
# --------------------------------------------------------------------------- #
def _secret_key() -> str | None:
    key = getattr(settings, "stripe_secret_key", None) or os.environ.get("KEFU_STRIPE_SECRET_KEY")
    return key.strip() if isinstance(key, str) and key.strip() else None


def webhook_secret() -> str | None:
    sec = getattr(settings, "stripe_webhook_secret", None) or os.environ.get(
        "KEFU_STRIPE_WEBHOOK_SECRET"
    )
    return sec.strip() if isinstance(sec, str) and sec.strip() else None


def is_enabled() -> bool:
    """是否已設定 Stripe secret key(可建立 Checkout)。"""
    return _secret_key() is not None


def webhook_enabled() -> bool:
    """是否已設定 webhook 簽章密鑰(可驗簽 webhook)。"""
    return webhook_secret() is not None


# --------------------------------------------------------------------------- #
# 表單參數扁平化(Stripe 用 form-encoded 巢狀 key,如 line_items[0][price_data][currency])
# --------------------------------------------------------------------------- #
def _flatten(data: dict[str, Any], prefix: str = "") -> dict[str, str]:
    """把巢狀 dict / list 攤平成 Stripe form-urlencoded 的鍵名。"""
    out: dict[str, str] = {}
    for key, value in data.items():
        composed = f"{prefix}[{key}]" if prefix else str(key)
        if isinstance(value, dict):
            out.update(_flatten(value, composed))
        elif isinstance(value, (list, tuple)):
            for idx, item in enumerate(value):
                node = f"{composed}[{idx}]"
                if isinstance(item, dict):
                    out.update(_flatten(item, node))
                else:
                    out[node] = str(item)
        elif isinstance(value, bool):
            out[composed] = "true" if value else "false"
        elif value is not None:
            out[composed] = str(value)
    return out


def _interval(billing_period: str | None) -> str:
    return "year" if (billing_period or "").lower() in ("yearly", "year", "annual") else "month"


# --------------------------------------------------------------------------- #
# Checkout Session
# --------------------------------------------------------------------------- #
class StripeError(RuntimeError):
    """Stripe API 呼叫失敗(非 2xx 或連線問題)。"""


async def create_checkout_session(
    *,
    plan: Any,
    tenant_id: str,
    success_url: str,
    cancel_url: str,
    customer_id: str | None = None,
    client_reference_id: str | None = None,
) -> dict[str, str]:
    """建立**訂閱型** Checkout Session,回 ``{"id", "url"}``(url 為 Stripe 託管結帳頁)。

    以 ``price_data`` 內嵌方案價格,免預建 Stripe Product / Price;金額取自方案
    ``price_cents``(退而取 ``price_monthly``),幣別 / 週期取自方案。tenant_id / plan_id
    寫入 metadata 與 subscription_data.metadata,供 webhook 回關(不依賴 JSONB 查詢)。
    """
    key = _secret_key()
    if not key:
        raise StripeError("Stripe 未設定")

    amount = int(getattr(plan, "price_cents", 0) or 0) or int(getattr(plan, "price_monthly", 0) or 0)
    currency = str(getattr(plan, "currency", "USD") or "USD").lower()
    interval = _interval(getattr(plan, "billing_period", None))
    plan_id = str(getattr(plan, "id", ""))
    plan_name = str(getattr(plan, "name", None) or getattr(plan, "code", None) or "Subscription")

    body: dict[str, Any] = {
        "mode": "subscription",
        "success_url": success_url,
        "cancel_url": cancel_url,
        "client_reference_id": client_reference_id or tenant_id,
        "line_items": [
            {
                "quantity": 1,
                "price_data": {
                    "currency": currency,
                    "unit_amount": amount,
                    "recurring": {"interval": interval},
                    "product_data": {"name": plan_name},
                },
            }
        ],
        "metadata": {"tenant_id": tenant_id, "plan_id": plan_id},
        "subscription_data": {"metadata": {"tenant_id": tenant_id, "plan_id": plan_id}},
    }
    if customer_id:
        body["customer"] = customer_id

    form = _flatten(body)
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(
            f"{STRIPE_API_BASE}/checkout/sessions",
            data=form,
            headers={"Authorization": f"Bearer {key}"},
        )
    if resp.status_code >= 400:
        detail = _error_message(resp)
        logger.warning("Stripe checkout 建立失敗 status=%s detail=%s", resp.status_code, detail)
        raise StripeError(detail)
    data = resp.json()
    return {"id": data.get("id", ""), "url": data.get("url", "")}


def _error_message(resp: httpx.Response) -> str:
    try:
        return str(resp.json().get("error", {}).get("message") or f"HTTP {resp.status_code}")
    except Exception:
        return f"HTTP {resp.status_code}"


# --------------------------------------------------------------------------- #
# Webhook 驗簽
# --------------------------------------------------------------------------- #
def verify_webhook(payload: bytes, sig_header: str | None, secret: str | None) -> dict | None:
    """驗證 Stripe-Signature 並回傳事件 dict;驗章失敗回 None。

    Stripe-Signature 格式:``t=<ts>,v1=<sig>[,v0=...]``。簽章對 ``"{t}.{payload}"`` 以
    secret 做 HMAC-SHA256。以 compare_digest 比對任一 v1;逾時(> _SIG_TOLERANCE)視為重放。
    """
    if not secret or not sig_header:
        return None
    try:
        parts = dict(
            item.split("=", 1) for item in sig_header.split(",") if "=" in item
        )
    except ValueError:
        return None
    timestamp = parts.get("t")
    given = parts.get("v1")
    if not timestamp or not given:
        return None

    signed_payload = f"{timestamp}.{payload.decode('utf-8')}"
    expected = hmac.new(secret.encode("utf-8"), signed_payload.encode("utf-8"), hashlib.sha256).hexdigest()
    # encode 成 bytes:given 取自公開 webhook 的 Stripe-Signature 標頭(攻擊者可控),
    # 非 ASCII 直接比 str 會拋 TypeError → 500。
    if not hmac.compare_digest(expected.encode("utf-8"), str(given).encode("utf-8")):
        return None
    # 時間戳容許誤差(防重放);時間戳非數值則略過此檢查
    try:
        if abs(time.time() - int(timestamp)) > _SIG_TOLERANCE:
            logger.warning("Stripe webhook 時間戳超出容許誤差,拒收")
            return None
    except (TypeError, ValueError):
        pass
    try:
        return json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


# --------------------------------------------------------------------------- #
# 事件正規化(純函式,不碰 DB)
# --------------------------------------------------------------------------- #
def handle_event(event: dict) -> dict | None:
    """把 Stripe 事件正規化成本地更新指令;不處理的事件回 None。

    回傳(擇要):``{event_type, tenant_id, plan_id, status,
    stripe_customer_id, stripe_subscription_id, checkout_session_id}``。
    """
    etype = event.get("type")
    obj = (event.get("data") or {}).get("object") or {}
    if etype == "checkout.session.completed":
        meta = obj.get("metadata") or {}
        return {
            "event_type": etype,
            "tenant_id": meta.get("tenant_id") or obj.get("client_reference_id"),
            "plan_id": meta.get("plan_id"),
            "status": "active",
            "stripe_customer_id": obj.get("customer"),
            "stripe_subscription_id": obj.get("subscription"),
            "checkout_session_id": obj.get("id"),
        }
    if etype in ("customer.subscription.updated", "customer.subscription.deleted"):
        meta = obj.get("metadata") or {}
        raw_status = "canceled" if etype.endswith("deleted") else obj.get("status")
        return {
            "event_type": etype,
            "tenant_id": meta.get("tenant_id"),
            "plan_id": meta.get("plan_id"),
            "status": _STATUS_MAP.get(raw_status or "", raw_status or "active"),
            "stripe_customer_id": obj.get("customer"),
            "stripe_subscription_id": obj.get("id"),
            "checkout_session_id": None,
        }
    return None
