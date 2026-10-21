"""套餐(方案)功能目錄 + 功能 gating seam(本模組擁有)。

其他模組(翻譯、渠道、報表、坐席…)只需呼叫本檔的 gating 函式,不必知道方案結構:

    from app.services.plans import tenant_has_feature, FEATURE_TRANSLATE_OURS

    if not await tenant_has_feature(db, tenant_id, FEATURE_TRANSLATE_OURS):
        raise HTTPException(402, "此功能需升級方案")

設計要點:
- **功能目錄(FEATURE_CATALOG)**是唯一真實來源:定義每個功能鍵、名稱、型別
  (bool 開關 / limit 數值上限)與其「未訂閱時的預設值」。
- **預設方案(DEFAULT_PLANS)**:Free / Pro / Enterprise,各自宣告 features。
  ``seed_default_plans`` 把它們寫進某租戶(平台/轉售者)名下,idempotent。
- **gating**:讀租戶「生效訂閱 → plan.features」;無生效訂閱一律視為 **Free**
  (用 DEFAULT_PLANS['free'] 的 features 當底,故未種方案的租戶也能正確 gate)。
- 數值型上限以 ``None`` 表示「無限」(如 Enterprise 座席數)。
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing import Plan, Subscription

# --------------------------------------------------------------------------- #
# 功能鍵常數(供他模組引用,避免字串拼錯)
# --------------------------------------------------------------------------- #
FEATURE_TRANSLATE_GOOGLE = "translate.google"   # Google 免費翻譯(所有方案)
FEATURE_TRANSLATE_OURS = "translate.ours"       # 我方 LLM 翻譯(付費)
FEATURE_TRANSLATE_CUSTOM = "translate.custom"   # 客戶自訂翻譯 API(付費)
FEATURE_CHANNELS_TELEGRAM = "channels.telegram"  # Telegram 渠道(進階)
FEATURE_CHANNELS_EXTRA = "channels.extra"        # 其他進階渠道(進階)
FEATURE_REPORTS_ADVANCED = "reports.advanced"    # 進階報表(付費)
FEATURE_AGENTS_MAX = "agents.max"                # 座席數上限(數值型)

FeatureType = Literal["bool", "limit"]

# 數值型上限的「無限」哨兵:JSONB 存 null,gating 回傳 None。
UNLIMITED: None = None


# --------------------------------------------------------------------------- #
# 功能目錄:唯一真實來源
# 每項:key / name(顯示名)/ type / default(未訂閱=Free 時的保底值)/ description
# --------------------------------------------------------------------------- #
FEATURE_CATALOG: dict[str, dict[str, Any]] = {
    FEATURE_TRANSLATE_GOOGLE: {
        "key": FEATURE_TRANSLATE_GOOGLE,
        "name": "Google 翻譯",
        "type": "bool",
        "default": True,   # 免費、所有方案皆有
        "description": "Google 免費公開翻譯端點,零成本,所有方案內建。",
    },
    FEATURE_TRANSLATE_OURS: {
        "key": FEATURE_TRANSLATE_OURS,
        "name": "我方 LLM 翻譯",
        "type": "bool",
        "default": False,
        "description": "以我方 LLM(gpt-5.5)進行高品質翻譯,付費方案解鎖。",
    },
    FEATURE_TRANSLATE_CUSTOM: {
        "key": FEATURE_TRANSLATE_CUSTOM,
        "name": "自訂翻譯 API",
        "type": "bool",
        "default": False,
        "description": "串接客戶自備的翻譯 API(端點/金鑰由租戶設定),Enterprise 解鎖。",
    },
    FEATURE_CHANNELS_TELEGRAM: {
        "key": FEATURE_CHANNELS_TELEGRAM,
        "name": "Telegram 渠道",
        "type": "bool",
        "default": False,
        "description": "接入 Telegram 作為客服渠道,進階方案解鎖。",
    },
    FEATURE_CHANNELS_EXTRA: {
        "key": FEATURE_CHANNELS_EXTRA,
        "name": "進階渠道",
        "type": "bool",
        "default": False,
        "description": "其他進階渠道(如 LINE / WhatsApp 等),進階方案解鎖。",
    },
    FEATURE_REPORTS_ADVANCED: {
        "key": FEATURE_REPORTS_ADVANCED,
        "name": "進階報表",
        "type": "bool",
        "default": False,
        "description": "逐日/渠道維度、留存與品質等進階分析報表。",
    },
    FEATURE_AGENTS_MAX: {
        "key": FEATURE_AGENTS_MAX,
        "name": "座席數上限",
        "type": "limit",
        "default": 3,       # 未訂閱=Free 的保底座席數
        "description": "可建立的坐席席位上限;null 代表無限。",
    },
}

# 生效訂閱的狀態(其餘狀態如 canceled / past_due 視為未生效 → 回退 Free)
EFFECTIVE_STATUSES = frozenset({"active", "trialing"})


# --------------------------------------------------------------------------- #
# 預設方案:Free / Pro / Enterprise
# price 皆為「分」;seed 時 price_cents 與 price_monthly 設為一致。
# --------------------------------------------------------------------------- #
DEFAULT_PLANS: list[dict[str, Any]] = [
    {
        "code": "free",
        "name": "Free",
        "description": "免費方案:Google 翻譯、基本渠道、少量座席。",
        "price_monthly": 0,
        "sort": 0,
        "features": {
            FEATURE_TRANSLATE_GOOGLE: True,
            FEATURE_TRANSLATE_OURS: False,
            FEATURE_TRANSLATE_CUSTOM: False,
            FEATURE_CHANNELS_TELEGRAM: False,
            FEATURE_CHANNELS_EXTRA: False,
            FEATURE_REPORTS_ADVANCED: False,
            FEATURE_AGENTS_MAX: 3,
        },
    },
    {
        "code": "pro",
        "name": "Pro",
        "description": "進階方案:解鎖我方 LLM 翻譯、進階渠道、進階報表,較多座席。",
        "price_monthly": 4900,  # $49
        "sort": 10,
        "features": {
            FEATURE_TRANSLATE_GOOGLE: True,
            FEATURE_TRANSLATE_OURS: True,
            FEATURE_TRANSLATE_CUSTOM: False,
            FEATURE_CHANNELS_TELEGRAM: True,
            FEATURE_CHANNELS_EXTRA: True,
            FEATURE_REPORTS_ADVANCED: True,
            FEATURE_AGENTS_MAX: 25,
        },
    },
    {
        "code": "enterprise",
        "name": "Enterprise",
        "description": "旗艦方案:全功能 + 自訂翻譯 API + 無限座席。",
        "price_monthly": 19900,  # $199
        "sort": 20,
        "features": {
            FEATURE_TRANSLATE_GOOGLE: True,
            FEATURE_TRANSLATE_OURS: True,
            FEATURE_TRANSLATE_CUSTOM: True,
            FEATURE_CHANNELS_TELEGRAM: True,
            FEATURE_CHANNELS_EXTRA: True,
            FEATURE_REPORTS_ADVANCED: True,
            FEATURE_AGENTS_MAX: UNLIMITED,  # 無限座席
        },
    },
]

# Free 的 features:未訂閱租戶的保底,gating 一律以此為底。
FREE_FEATURES: dict[str, Any] = next(p for p in DEFAULT_PLANS if p["code"] == "free")["features"]


# --------------------------------------------------------------------------- #
# 純函式:功能解析(不碰 DB,便於單元測試)
# --------------------------------------------------------------------------- #
def catalog_defaults() -> dict[str, Any]:
    """回傳「目錄預設值」字典(等同未訂閱=Free 的保底)。"""
    return {k: meta["default"] for k, meta in FEATURE_CATALOG.items()}


def resolve_features(plan_features: dict[str, Any] | None) -> dict[str, Any]:
    """把某方案的 features 疊到目錄預設上,回傳「每個功能鍵的生效值」。

    - plan_features 為 None(無方案/無訂閱)→ 等同 Free 保底(catalog default)。
    - 只採目錄內定義的鍵,未知鍵忽略;方案缺的鍵回退到目錄預設值。
    - bool 型一律轉為 True/False;limit 型保留 int 或 None(無限)。
    """
    resolved: dict[str, Any] = {}
    src = plan_features or {}
    for key, meta in FEATURE_CATALOG.items():
        raw = src.get(key, meta["default"])
        if meta["type"] == "bool":
            resolved[key] = bool(raw)
        else:  # limit
            resolved[key] = None if raw is None else int(raw)
    return resolved


def feature_type(feature_key: str) -> FeatureType | None:
    meta = FEATURE_CATALOG.get(feature_key)
    return meta["type"] if meta else None


# --------------------------------------------------------------------------- #
# DB 取數:租戶生效方案的 features
# --------------------------------------------------------------------------- #
async def _effective_plan(db: AsyncSession, tenant_id: uuid.UUID) -> Plan | None:
    """取租戶「生效訂閱」對應的方案;無生效訂閱回 None(呼叫端當 Free 處理)。

    生效 = 最新一筆(started_at desc)未刪除、狀態屬 EFFECTIVE_STATUSES 的訂閱。
    """
    sub = (
        await db.execute(
            select(Subscription)
            .where(
                Subscription.tenant_id == tenant_id,
                Subscription.deleted_at.is_(None),
                Subscription.status.in_(EFFECTIVE_STATUSES),
            )
            .order_by(Subscription.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if sub is None:
        return None
    return (
        await db.execute(select(Plan).where(Plan.id == sub.plan_id))
    ).scalar_one_or_none()


async def effective_features(db: AsyncSession, tenant_id: uuid.UUID) -> dict[str, Any]:
    """租戶「生效功能字典」:每個功能鍵 → 生效值(bool / int / None)。

    無生效訂閱、或方案不存在 → 回 Free 保底。這是 gating 的共同底層。
    """
    plan = await _effective_plan(db, tenant_id)
    plan_features = plan.features if plan is not None else FREE_FEATURES
    return resolve_features(plan_features)


# --------------------------------------------------------------------------- #
# gating seam(給其他模組呼叫的公開 API)
# --------------------------------------------------------------------------- #
async def tenant_has_feature(db: AsyncSession, tenant_id: uuid.UUID, feature_key: str) -> bool:
    """租戶是否具備某(bool 型)功能。無訂閱視為 Free。

    - bool 型:回傳其開關值。
    - limit 型:視為「上限 > 0 或無限」則 True(有配額即算具備)。
    - 未知功能鍵:False。
    """
    if feature_key not in FEATURE_CATALOG:
        return False
    feats = await effective_features(db, tenant_id)
    value = feats.get(feature_key)
    if FEATURE_CATALOG[feature_key]["type"] == "limit":
        return value is None or int(value) > 0
    return bool(value)


async def tenant_feature_limit(
    db: AsyncSession, tenant_id: uuid.UUID, feature_key: str
) -> int | None:
    """租戶某(limit 型)功能的數值上限。None = 無限。

    非 limit 型或未知鍵 → 回 None(呼叫端應只對 limit 型使用)。
    無訂閱視為 Free 保底值。
    """
    if feature_type(feature_key) != "limit":
        return None
    feats = await effective_features(db, tenant_id)
    return feats.get(feature_key)  # int 或 None(無限)


async def tenant_features(db: AsyncSession, tenant_id: uuid.UUID) -> dict[str, Any]:
    """回傳租戶全部功能狀態字典,供前端顯示鎖/升級提示。無訂閱視為 Free。"""
    return await effective_features(db, tenant_id)


# --------------------------------------------------------------------------- #
# 種預設方案
# --------------------------------------------------------------------------- #
async def seed_default_plans(db: AsyncSession, tenant_id: uuid.UUID) -> list[Plan]:
    """為某租戶(平台/轉售者)種 Free / Pro / Enterprise 三個公開方案。

    idempotent:以 (tenant_id, code) 判重,已存在則沿用不重建。
    僅 flush 取得主鍵、不 commit(交由呼叫端交易),與 record_usage 慣例一致。
    回傳三個 Plan(依 sort 排序)。
    """
    existing = {
        p.code: p
        for p in (
            await db.execute(
                select(Plan).where(
                    Plan.tenant_id == tenant_id,
                    Plan.deleted_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    }
    result: list[Plan] = []
    for spec in DEFAULT_PLANS:
        found = existing.get(spec["code"])
        if found is not None:
            result.append(found)
            continue
        plan = Plan(
            tenant_id=tenant_id,
            code=spec["code"],
            name=spec["name"],
            description=spec["description"],
            price_cents=spec["price_monthly"],
            price_monthly=spec["price_monthly"],
            currency="USD",
            billing_period="monthly",
            features=dict(spec["features"]),
            is_public=True,
            is_active=True,
            sort=spec["sort"],
        )
        db.add(plan)
        result.append(plan)
    await db.flush()
    result.sort(key=lambda p: p.sort or 0)
    return result


async def ensure_free_subscription(db: AsyncSession, tenant_id: uuid.UUID) -> Subscription:
    """確保新租戶預設訂閱 Free 方案:若尚無任何生效訂閱則建立一筆指向 Free 的訂閱。

    會先確保該租戶已種預設方案(seed_default_plans)。僅 flush 不 commit。
    供租戶開通流程呼叫;不呼叫也無妨——gating 對「無訂閱」本就當 Free 處理。
    """
    plans = await seed_default_plans(db, tenant_id)
    free = next(p for p in plans if p.code == "free")
    existing = (
        await db.execute(
            select(Subscription).where(
                Subscription.tenant_id == tenant_id,
                Subscription.deleted_at.is_(None),
                Subscription.status.in_(EFFECTIVE_STATUSES),
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    sub = Subscription(
        tenant_id=tenant_id,
        plan_id=free.id,
        status="active",
        seats=1,
    )
    db.add(sub)
    await db.flush()
    return sub
