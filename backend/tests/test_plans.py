"""套餐(方案)+ 功能 gating 測試(app/services/plans.py 與 billing API 路由)。

原則同 test_reporting_billing.py:不依賴外部 Postgres。
- 純函式(resolve_features / catalog / DEFAULT_PLANS 內容)直接驗算;
- gating 的 DB 取數用輕量 fake async session 餵預定結果,驗證解析與回退邏輯;
- seed_default_plans 用 fake session 驗證新增與 idempotent;
- 路由掛載以 router.routes 路徑集合驗證端點齊全。
（生效訂閱的 SQL 狀態過濾屬 DB 層,留待整合階段接真 DB。)
"""
from __future__ import annotations

import uuid

import pytest

from app.models.billing import Plan, Subscription
from app.services import plans as P
from app.services.plans import (
    DEFAULT_PLANS,
    FEATURE_AGENTS_MAX,
    FEATURE_CATALOG,
    FEATURE_CHANNELS_EXTRA,
    FEATURE_CHANNELS_TELEGRAM,
    FEATURE_REPORTS_ADVANCED,
    FEATURE_TRANSLATE_CUSTOM,
    FEATURE_TRANSLATE_GOOGLE,
    FEATURE_TRANSLATE_OURS,
    catalog_defaults,
    resolve_features,
    seed_default_plans,
    tenant_feature_limit,
    tenant_features,
    tenant_has_feature,
)


# --------------------------------------------------------------------------- #
# fake async session:依序回傳預定結果
# --------------------------------------------------------------------------- #
class _FakeResult:
    def __init__(self, objs: list):
        self._objs = objs

    def scalar_one_or_none(self):
        return self._objs[0] if self._objs else None

    def scalars(self):
        return self

    def all(self):
        return list(self._objs)


class _FakeSession:
    """execute 依 _results 佇列逐次回傳;add/flush 記錄(flush 補 id 模擬 DB)。"""

    def __init__(self, results: list[list] | None = None):
        self._results = list(results or [])
        self.added: list = []
        self.flush_count = 0

    async def execute(self, *_a, **_k):
        return _FakeResult(self._results.pop(0) if self._results else [])

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        self.flush_count += 1
        for obj in self.added:
            if getattr(obj, "id", None) is None:
                obj.id = uuid.uuid4()


def _plan_with(code: str, features: dict) -> Plan:
    return Plan(id=uuid.uuid4(), tenant_id=uuid.uuid4(), code=code, name=code, features=features)


def _default_features(code: str) -> dict:
    return dict(next(p for p in DEFAULT_PLANS if p["code"] == code)["features"])


# --------------------------------------------------------------------------- #
# 功能目錄完整性
# --------------------------------------------------------------------------- #
def test_catalog_covers_required_feature_keys():
    required = {
        FEATURE_TRANSLATE_GOOGLE,
        FEATURE_TRANSLATE_OURS,
        FEATURE_TRANSLATE_CUSTOM,
        FEATURE_CHANNELS_TELEGRAM,
        FEATURE_CHANNELS_EXTRA,
        FEATURE_REPORTS_ADVANCED,
        FEATURE_AGENTS_MAX,
    }
    assert required <= set(FEATURE_CATALOG)


def test_catalog_entries_wellformed():
    for key, meta in FEATURE_CATALOG.items():
        assert meta["key"] == key
        assert meta["type"] in ("bool", "limit")
        assert meta["name"] and meta["description"]
        assert "default" in meta


def test_agents_max_is_limit_others_are_bool():
    assert FEATURE_CATALOG[FEATURE_AGENTS_MAX]["type"] == "limit"
    assert FEATURE_CATALOG[FEATURE_TRANSLATE_OURS]["type"] == "bool"


# --------------------------------------------------------------------------- #
# 預設方案內容符合規格
# --------------------------------------------------------------------------- #
def test_default_plans_are_free_pro_enterprise():
    assert [p["code"] for p in DEFAULT_PLANS] == ["free", "pro", "enterprise"]


def test_free_plan_only_google_and_limited_seats():
    f = _default_features("free")
    assert f[FEATURE_TRANSLATE_GOOGLE] is True
    assert f[FEATURE_TRANSLATE_OURS] is False
    assert f[FEATURE_TRANSLATE_CUSTOM] is False
    assert f[FEATURE_CHANNELS_TELEGRAM] is False
    assert f[FEATURE_REPORTS_ADVANCED] is False
    assert isinstance(f[FEATURE_AGENTS_MAX], int) and f[FEATURE_AGENTS_MAX] > 0


def test_pro_unlocks_ours_channels_reports_but_not_custom():
    p = _default_features("pro")
    assert p[FEATURE_TRANSLATE_OURS] is True
    assert p[FEATURE_TRANSLATE_CUSTOM] is False
    assert p[FEATURE_CHANNELS_TELEGRAM] is True
    assert p[FEATURE_CHANNELS_EXTRA] is True
    assert p[FEATURE_REPORTS_ADVANCED] is True
    assert p[FEATURE_AGENTS_MAX] > _default_features("free")[FEATURE_AGENTS_MAX]


def test_enterprise_unlocks_everything_with_unlimited_seats():
    e = _default_features("enterprise")
    assert e[FEATURE_TRANSLATE_CUSTOM] is True
    assert all(e[k] is True for k in FEATURE_CATALOG if FEATURE_CATALOG[k]["type"] == "bool")
    assert e[FEATURE_AGENTS_MAX] is None  # 無限座席


# --------------------------------------------------------------------------- #
# 純函式:resolve_features
# --------------------------------------------------------------------------- #
def test_resolve_none_gives_catalog_defaults():
    assert resolve_features(None) == catalog_defaults()


def test_resolve_coerces_bool_and_limit_types():
    resolved = resolve_features({FEATURE_TRANSLATE_OURS: 1, FEATURE_AGENTS_MAX: "10"})
    assert resolved[FEATURE_TRANSLATE_OURS] is True     # 1 → True
    assert resolved[FEATURE_AGENTS_MAX] == 10           # "10" → int
    # 缺的鍵回退目錄預設
    assert resolved[FEATURE_TRANSLATE_CUSTOM] is False


def test_resolve_keeps_unlimited_none():
    assert resolve_features({FEATURE_AGENTS_MAX: None})[FEATURE_AGENTS_MAX] is None


def test_resolve_ignores_unknown_keys():
    assert "bogus.key" not in resolve_features({"bogus.key": True})


# --------------------------------------------------------------------------- #
# gating:無訂閱視為 Free
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_subscription_is_free():
    db = _FakeSession(results=[[]])  # 查訂閱 → 無
    tid = uuid.uuid4()
    assert await tenant_has_feature(db, tid, FEATURE_TRANSLATE_GOOGLE) is True
    # 每次呼叫獨立取數,補足佇列
    db._results = [[]]
    assert await tenant_has_feature(db, tid, FEATURE_TRANSLATE_OURS) is False


@pytest.mark.asyncio
async def test_no_subscription_features_equal_free():
    db = _FakeSession(results=[[]])
    feats = await tenant_features(db, uuid.uuid4())
    assert feats == resolve_features(_default_features("free"))


# --------------------------------------------------------------------------- #
# gating:有生效訂閱 → 讀 plan.features
# --------------------------------------------------------------------------- #
def _sub_and_plan(code: str):
    """回傳可餵給 fake session 的兩批結果:先訂閱、後方案。"""
    plan = _plan_with(code, _default_features(code))
    sub = Subscription(id=uuid.uuid4(), tenant_id=uuid.uuid4(), plan_id=plan.id, status="active")
    return [[sub], [plan]]


@pytest.mark.asyncio
async def test_pro_subscription_unlocks_ours():
    db = _FakeSession(results=_sub_and_plan("pro"))
    assert await tenant_has_feature(db, uuid.uuid4(), FEATURE_TRANSLATE_OURS) is True


@pytest.mark.asyncio
async def test_pro_subscription_still_locks_custom():
    db = _FakeSession(results=_sub_and_plan("pro"))
    assert await tenant_has_feature(db, uuid.uuid4(), FEATURE_TRANSLATE_CUSTOM) is False


@pytest.mark.asyncio
async def test_enterprise_seat_limit_is_unlimited_none():
    db = _FakeSession(results=_sub_and_plan("enterprise"))
    assert await tenant_feature_limit(db, uuid.uuid4(), FEATURE_AGENTS_MAX) is None


@pytest.mark.asyncio
async def test_free_seat_limit_is_number():
    db = _FakeSession(results=[[]])
    limit = await tenant_feature_limit(db, uuid.uuid4(), FEATURE_AGENTS_MAX)
    assert limit == _default_features("free")[FEATURE_AGENTS_MAX]


@pytest.mark.asyncio
async def test_has_feature_true_for_positive_limit():
    """limit 型:配額>0 或無限視為具備。"""
    db = _FakeSession(results=[[]])
    assert await tenant_has_feature(db, uuid.uuid4(), FEATURE_AGENTS_MAX) is True


@pytest.mark.asyncio
async def test_unknown_feature_is_false_and_none():
    db = _FakeSession(results=[[]])
    assert await tenant_has_feature(db, uuid.uuid4(), "does.not.exist") is False
    assert await tenant_feature_limit(db, uuid.uuid4(), "does.not.exist") is None


@pytest.mark.asyncio
async def test_feature_limit_on_bool_feature_returns_none():
    db = _FakeSession(results=[[]])
    assert await tenant_feature_limit(db, uuid.uuid4(), FEATURE_TRANSLATE_OURS) is None


# --------------------------------------------------------------------------- #
# seed_default_plans
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_seed_creates_three_plans_when_empty():
    db = _FakeSession(results=[[]])  # 查既有方案 → 無
    tid = uuid.uuid4()
    created = await seed_default_plans(db, tid)
    assert [p.code for p in created] == ["free", "pro", "enterprise"]
    assert len(db.added) == 3
    assert all(p.tenant_id == tid and p.is_public for p in db.added)
    # price_cents 與 price_monthly 一致
    assert all(p.price_cents == p.price_monthly for p in db.added)


@pytest.mark.asyncio
async def test_seed_is_idempotent():
    existing = [_plan_with(c, _default_features(c)) for c in ("free", "pro", "enterprise")]
    db = _FakeSession(results=[existing])
    created = await seed_default_plans(db, uuid.uuid4())
    assert db.added == []  # 已存在,不重建
    assert {p.code for p in created} == {"free", "pro", "enterprise"}


@pytest.mark.asyncio
async def test_ensure_free_subscription_returns_existing():
    tid = uuid.uuid4()
    existing_plans = [_plan_with(c, _default_features(c)) for c in ("free", "pro", "enterprise")]
    existing_sub = Subscription(id=uuid.uuid4(), tenant_id=tid, plan_id=existing_plans[0].id, status="active")
    # seed 查方案(已存在)→ 再查現有訂閱(存在)
    db = _FakeSession(results=[existing_plans, [existing_sub]])
    sub = await P.ensure_free_subscription(db, tid)
    assert sub is existing_sub
    assert db.added == []  # 不建新訂閱


@pytest.mark.asyncio
async def test_ensure_free_subscription_creates_when_missing():
    tid = uuid.uuid4()
    # seed 查方案(無)→ 建三方案;再查訂閱(無)→ 建 Free 訂閱
    db = _FakeSession(results=[[], []])
    sub = await P.ensure_free_subscription(db, tid)
    assert isinstance(sub, Subscription)
    assert sub.tenant_id == tid
    assert sub.status == "active"
    # 指向 free 方案
    free = next(p for p in db.added if isinstance(p, Plan) and p.code == "free")
    assert sub.plan_id == free.id


# --------------------------------------------------------------------------- #
# 路由掛載
# --------------------------------------------------------------------------- #
def test_billing_router_exposes_features_endpoint():
    from app.api.v1 import billing

    paths = {r.path for r in billing.router.routes}
    assert {"/plans", "/subscription", "/features"} <= paths
