"""M11 報表 + M12 計費 的測試。

以「不需外部 Postgres」為原則:
- 純函式(summarize_usage / estimate_charges)直接驗算;
- record_usage 用輕量 fake session 驗證寫入的欄位;
- 路由掛載以檢視 router.routes 的路徑集合驗證(端點齊全、方法正確)。
SQL 聚合端點的真整合測試留待整合階段接上真 DB。
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from app.models.billing import Plan, UsageRecord
from app.services.usage import (
    KIND_AI_REPLY,
    KIND_LLM_TOKENS,
    estimate_charges,
    record_usage,
    summarize_usage,
)


# --------------------------------------------------------------------------- #
# 純函式:彙總
# --------------------------------------------------------------------------- #
def test_summarize_usage_sums_by_kind():
    rows = [
        (KIND_AI_REPLY, 3),
        (KIND_LLM_TOKENS, Decimal("1000")),
        (KIND_AI_REPLY, 2),
        (KIND_LLM_TOKENS, 500),
    ]
    assert summarize_usage(rows) == {KIND_AI_REPLY: 5.0, KIND_LLM_TOKENS: 1500.0}


def test_summarize_usage_handles_none_quantity():
    assert summarize_usage([("session", None), ("session", 4)]) == {"session": 4.0}


# --------------------------------------------------------------------------- #
# 純函式:計價
# --------------------------------------------------------------------------- #
def _plan(**kw) -> Plan:
    base = dict(
        tenant_id=uuid.uuid4(),
        code="pro",
        name="Pro",
        price_cents=5000,  # 基礎費 $50
        currency="USD",
        unit_prices={KIND_AI_REPLY: 0.01, KIND_LLM_TOKENS: 0.000002},
        limits={"included": {KIND_AI_REPLY: 100}},
    )
    base.update(kw)
    return Plan(**base)


def test_estimate_charges_base_plus_metered_with_included_allowance():
    usage = {KIND_AI_REPLY: 150, KIND_LLM_TOKENS: 1_000_000}
    result = estimate_charges(usage, _plan(), byo_key=False)

    assert result["currency"] == "USD"
    assert result["base_fee"] == 50.0
    items = {i["kind"]: i for i in result["line_items"]}
    # ai_reply:150 - 內含100 = 50 計費,單價 0.01 → 0.5
    assert items[KIND_AI_REPLY]["billable_quantity"] == 50.0
    assert items[KIND_AI_REPLY]["amount"] == 0.5
    # llm_tokens:1,000,000 * 0.000002 = 2.0
    assert items[KIND_LLM_TOKENS]["amount"] == 2.0
    assert result["metered_total"] == 2.5
    assert result["total"] == 52.5


def test_estimate_charges_byo_key_excludes_llm_cost():
    usage = {KIND_AI_REPLY: 150, KIND_LLM_TOKENS: 1_000_000}
    result = estimate_charges(usage, _plan(), byo_key=True)
    items = {i["kind"]: i for i in result["line_items"]}
    # BYO-Key:llm_tokens 自負、不計費
    assert items[KIND_LLM_TOKENS]["self_funded"] is True
    assert items[KIND_LLM_TOKENS]["amount"] == 0.0
    # 只剩 ai_reply 的 0.5 計入
    assert result["metered_total"] == 0.5
    assert result["total"] == 50.5


def test_estimate_charges_no_plan_is_zero_but_reports_usage():
    result = estimate_charges({KIND_AI_REPLY: 10}, None, byo_key=False)
    assert result["base_fee"] == 0.0
    assert result["total"] == 0.0
    assert result["line_items"][0]["quantity"] == 10.0


# --------------------------------------------------------------------------- #
# record_usage seam(fake session)
# --------------------------------------------------------------------------- #
class _FakeSession:
    def __init__(self):
        self.added = []
        self.flushed = False

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        self.flushed = True


@pytest.mark.asyncio
async def test_record_usage_builds_record_and_flushes():
    db = _FakeSession()
    tid = uuid.uuid4()
    rec = await record_usage(db, tid, KIND_LLM_TOKENS, 1234, meta={"model": "gpt-5.5"})

    assert isinstance(rec, UsageRecord)
    assert rec.tenant_id == tid
    assert rec.kind == KIND_LLM_TOKENS
    assert rec.quantity == Decimal("1234")  # 轉為 Decimal 存 Numeric
    assert rec.meta == {"model": "gpt-5.5"}
    assert db.added == [rec]
    assert db.flushed is True  # flush 取主鍵,但不 commit(交由呼叫端交易)


@pytest.mark.asyncio
async def test_record_usage_float_quantity_is_exact_decimal():
    db = _FakeSession()
    rec = await record_usage(db, uuid.uuid4(), "cost", 0.1)
    assert rec.quantity == Decimal("0.1")  # 透過 str() 轉換避免浮點雜訊


# --------------------------------------------------------------------------- #
# 路由掛載
# --------------------------------------------------------------------------- #
def _paths(router) -> set[str]:
    return {r.path for r in router.routes}


def test_reporting_router_exposes_all_reports():
    from app.api.v1 import reporting

    assert _paths(reporting.router) == {
        "/overview",  # 單次聚合總覽(AI 解決率/CSAT/渠道分布/環比/逐日趨勢)
        "/insights",  # AI 聚合洞察(近 N 天熱門問題/情緒/建議)
        "/sales",  # 銷售/目標成交聚合(總額/逐目標/坐席業績排行)
        "/conversations/volume",
        "/agents/performance",
        "/queue/wait-times",
        "/satisfaction",
        "/quality",
        "/agent-activity",  # 坐席工時 / 活動報表
        "/schedules",  # 排程 / 訂閱式報表 CRUD
        "/schedules/{schedule_id}",
    }


def test_billing_router_exposes_plans_subscription_usage_and_reseller():
    from app.api.v1 import billing

    paths = _paths(billing.router)
    assert {
        "/plans",
        "/subscription",
        "/usage",
        "/invoice/summary",
        "/reseller/overview",
        "/reseller/tenants/{tenant_id}/usage",
    } <= paths
