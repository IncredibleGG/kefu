"""M12 計量 seam(本模組擁有)。

其他模組(LLM 編排、會話、坐席…)只需呼叫 ``record_usage`` 打點,不必知道計費細節:

    from app.services.usage import record_usage, KIND_LLM_TOKENS

    await record_usage(db, tenant_id, KIND_LLM_TOKENS, 1234, meta={"model": "gpt-5.5"})

彙總與計價的純函式(``summarize_usage`` / ``estimate_charges``)放這裡,供
app/api/v1/billing.py 依賴;它們不碰資料庫,便於單元測試。
"""
from __future__ import annotations

import uuid
from collections.abc import Iterable
from decimal import Decimal
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing import UsageRecord

# ---------------------------------------------------------------------------
# 計量種類常數(供他模組引用,避免字串拼錯)。kind 採自由字串,以下為約定值。
# ---------------------------------------------------------------------------
KIND_LLM_TOKENS = "llm_tokens"  # LLM 消耗 token(BYO-Key 時成本歸租戶自負)
KIND_AI_REPLY = "ai_reply"      # AI 自動回覆次數
KIND_SESSION = "session"        # 開啟的會話數
KIND_MESSAGE = "message"        # 訊息數
KIND_AGENT_SEAT = "agent_seat"  # 坐席席位(月結)

# BYO-Key 情境下由租戶自負、平台不計費的 kind。
SELF_FUNDED_KINDS = frozenset({KIND_LLM_TOKENS})


async def record_usage(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    kind: str,
    quantity: float | int | Decimal,
    meta: dict | None = None,
) -> UsageRecord:
    """寫入一筆計量事件並回傳(僅 flush 取得 id,commit 交由呼叫端的請求交易處理)。

    quantity 一律轉為 Decimal 存入 Numeric 欄位,避免浮點累積誤差。
    """
    record = UsageRecord(
        tenant_id=tenant_id,
        kind=kind,
        quantity=Decimal(str(quantity)),
        meta=meta,
    )
    db.add(record)
    await db.flush()  # 取得主鍵;不 commit,讓打點與呼叫端業務落在同一交易
    return record


def summarize_usage(rows: Iterable[tuple[str, Any]]) -> dict[str, float]:
    """把 (kind, quantity) 序列彙總成 {kind: 總量}。純函式,便於測試。"""
    totals: dict[str, float] = {}
    for kind, quantity in rows:
        totals[kind] = totals.get(kind, 0.0) + float(quantity or 0)
    return totals


def estimate_charges(
    usage_by_kind: dict[str, float],
    plan: Any | None,
    byo_key: bool = False,
) -> dict[str, Any]:
    """依方案與用量算出透明帳單。純函式(plan 只需具備 price_cents/currency/
    unit_prices/limits 屬性,傳 None 則視為無方案)。

    規則:
    - base_fee = plan.price_cents / 100(週期基礎服務費)。
    - 每個 kind 的計費量 = max(用量 - 方案內含額度, 0),再乘單價。
    - byo_key 為真時,SELF_FUNDED_KINDS(如 llm_tokens)不計費(amount=0、標記自負)。
    回傳含逐項明細,金額皆為貨幣主單位(float),供前端透明呈現。
    """
    price_cents = int(getattr(plan, "price_cents", 0) or 0) if plan is not None else 0
    currency = (getattr(plan, "currency", None) or "USD") if plan is not None else "USD"
    unit_prices: dict[str, Any] = (getattr(plan, "unit_prices", None) or {}) if plan is not None else {}
    limits: dict[str, Any] = (getattr(plan, "limits", None) or {}) if plan is not None else {}
    included: dict[str, Any] = limits.get("included", {}) if isinstance(limits, dict) else {}

    base_fee = round(price_cents / 100, 6)
    line_items: list[dict[str, Any]] = []
    metered_total = 0.0

    for kind in sorted(usage_by_kind):
        quantity = float(usage_by_kind[kind] or 0)
        self_funded = byo_key and kind in SELF_FUNDED_KINDS
        inc = float(included.get(kind, 0) or 0)
        billable_qty = max(quantity - inc, 0.0)
        unit_price = float(unit_prices.get(kind, 0) or 0)
        amount = 0.0 if self_funded else round(billable_qty * unit_price, 6)
        metered_total += amount
        line_items.append(
            {
                "kind": kind,
                "quantity": quantity,
                "included": inc,
                "billable_quantity": billable_qty,
                "unit_price": unit_price,
                "amount": amount,
                "self_funded": self_funded,
            }
        )

    metered_total = round(metered_total, 6)
    return {
        "currency": currency,
        "base_fee": base_fee,
        "line_items": line_items,
        "metered_total": metered_total,
        "total": round(base_fee + metered_total, 6),
        "byo_key": byo_key,
    }
