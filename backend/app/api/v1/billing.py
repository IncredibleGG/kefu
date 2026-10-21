"""M12 計費 / 白牌轉售 API(router 前綴由 main.py 掛為 /api/v1/billing)。

- 方案 Plan:列出 / 建立(建立需 tenant.manage)。
- 訂閱 Subscription:查目前訂閱 / 訂閱或換方案(需 tenant.manage)。
- 用量帳單彙總:依 UsageRecord 聚合(可帶時間區間),並依方案透明計價;
  BYO-Key 時 LLM 成本歸租戶自負,不計入平台帳單。
- 白牌轉售儀表板:轉售者(reseller 角色 / admin)可跨其名下租戶
  (Subscription.reseller_tenant_id == 自身 tenant_id)彙總用量與計費。

全部依 Principal 做租戶隔離與角色控管,回傳統一信封 ok(...)。
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select

from app.core.deps import CurrentStaff, DbSession, Principal
from app.core.response import err, ok
from app.models.billing import Coupon, Invoice, Plan, Subscription, UsageRecord
from app.models.tenancy import Tenant
from app.services import provisioning, stripe_gateway
from app.services.plans import EFFECTIVE_STATUSES, FEATURE_CATALOG, tenant_features
from app.services.usage import estimate_charges, summarize_usage

router = APIRouter()

StartQ = Annotated[datetime | None, Query(description="起始時間(含)")]
EndQ = Annotated[datetime | None, Query(description="結束時間(不含)")]


# --------------------------------------------------------------------------- #
# 輔助
# --------------------------------------------------------------------------- #
def _require_reseller(staff: Principal) -> None:
    """轉售視圖限 reseller 角色或 admin。"""
    if "admin" in staff.roles or "reseller" in staff.roles:
        return
    raise HTTPException(status.HTTP_403_FORBIDDEN, detail="需要 reseller 角色")


def _plan_out(p: Plan) -> dict:
    return {
        "id": str(p.id),
        "code": p.code,
        "name": p.name,
        "description": p.description,
        "price_cents": p.price_cents,
        "price_monthly": p.price_monthly,
        "currency": p.currency,
        "billing_period": p.billing_period,
        "features": p.features,
        "limits": p.limits,
        "unit_prices": p.unit_prices,
        "is_active": p.is_active,
        "is_public": p.is_public,
        "sort": p.sort,
    }


def _subscription_out(s: Subscription) -> dict:
    return {
        "id": str(s.id),
        "tenant_id": str(s.tenant_id),
        "plan_id": str(s.plan_id),
        "reseller_tenant_id": str(s.reseller_tenant_id) if s.reseller_tenant_id else None,
        "status": s.status,
        "byo_key": s.byo_key,
        "seats": s.seats,
        "current_period_start": s.current_period_start,
        "current_period_end": s.current_period_end,
    }


async def _usage_by_kind(
    db: DbSession, tenant_ids: list[uuid.UUID], start: datetime | None, end: datetime | None
) -> dict[str, float]:
    """把一批租戶在時間區間內的 UsageRecord 依 kind 聚合(SQL SUM)。"""
    conds = [UsageRecord.tenant_id.in_(tenant_ids), UsageRecord.deleted_at.is_(None)]
    if start is not None:
        conds.append(UsageRecord.recorded_at >= start)
    if end is not None:
        conds.append(UsageRecord.recorded_at < end)
    rows = (
        await db.execute(
            select(UsageRecord.kind, func.coalesce(func.sum(UsageRecord.quantity), 0))
            .where(and_(*conds))
            .group_by(UsageRecord.kind)
        )
    ).all()
    return summarize_usage(rows)


async def _active_subscription(db: DbSession, tenant_id: uuid.UUID) -> Subscription | None:
    return (
        await db.execute(
            select(Subscription)
            .where(
                Subscription.tenant_id == tenant_id,
                Subscription.deleted_at.is_(None),
            )
            .order_by(Subscription.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


def _plan_price(p: Plan | None) -> int:
    """方案的付費金額(分):取 price_cents 與 price_monthly 較大者(seed 時兩者一致)。

    與 /checkout 的「可結帳」判斷一致:>0 即視為付費方案。None(方案佚失)視為 0。
    """
    if p is None:
        return 0
    return max(int(p.price_cents or 0), int(p.price_monthly or 0))


async def _effective_current_price(db: DbSession, tenant_id: uuid.UUID) -> int:
    """租戶「目前生效方案」的付費金額(分);無生效訂閱或方案佚失視為 0(Free)。

    僅取狀態屬 EFFECTIVE_STATUSES(active / trialing)的最新一筆,供自助換方案的
    付款門檻判斷「是否為升級到更貴的付費方案」。
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
        return 0
    plan = (await db.execute(select(Plan).where(Plan.id == sub.plan_id))).scalar_one_or_none()
    return _plan_price(plan)


# --------------------------------------------------------------------------- #
# Plan
# --------------------------------------------------------------------------- #
class PlanIn(BaseModel):
    code: str
    name: str
    description: str | None = None
    price_cents: int = 0
    price_monthly: int = 0
    currency: str = "USD"
    billing_period: str = "monthly"
    features: dict | None = None
    limits: dict | None = None
    unit_prices: dict | None = None
    is_active: bool = True
    is_public: bool = True
    sort: int = 0


@router.get("/plans")
async def list_plans(
    staff: CurrentStaff,
    db: DbSession,
    include_inactive: bool = False,
    include_private: bool = False,
):
    """列出本租戶(平台/轉售者)發行的公開方案(供陳列/選購)。

    預設只回 is_public 且 is_active 的方案並依 sort、price 排序。
    管理用途可帶 include_inactive / include_private 取全部。
    """
    conds = [Plan.tenant_id == staff.tenant_id, Plan.deleted_at.is_(None)]
    if not include_inactive:
        conds.append(Plan.is_active.is_(True))
    if not include_private:
        conds.append(Plan.is_public.is_(True))
    rows = (
        await db.execute(
            select(Plan).where(and_(*conds)).order_by(Plan.sort, Plan.price_monthly)
        )
    ).scalars().all()
    return ok({"plans": [_plan_out(p) for p in rows]})


@router.post("/plans", status_code=status.HTTP_201_CREATED)
async def create_plan(body: PlanIn, staff: CurrentStaff, db: DbSession):
    """建立方案(需 tenant.manage)。"""
    staff.require("tenant.manage")
    plan = Plan(tenant_id=staff.tenant_id, **body.model_dump())
    db.add(plan)
    await db.commit()
    await db.refresh(plan)
    return ok(_plan_out(plan))


# --------------------------------------------------------------------------- #
# Subscription
# --------------------------------------------------------------------------- #
class SubscriptionIn(BaseModel):
    plan_id: uuid.UUID
    byo_key: bool = False
    seats: int = Field(default=1, ge=1)
    reseller_tenant_id: uuid.UUID | None = None
    current_period_start: datetime | None = None
    current_period_end: datetime | None = None


@router.get("/subscription")
async def get_subscription(staff: CurrentStaff, db: DbSession):
    """查本租戶目前(最新)訂閱、方案與「生效功能字典」。

    無訂閱時 subscription/plan 皆為 null,但 features 仍回 Free 保底,
    前端可直接據此顯示鎖/升級提示。
    """
    features = await tenant_features(db, staff.tenant_id)
    sub = await _active_subscription(db, staff.tenant_id)
    if not sub:
        return ok({"subscription": None, "plan": None, "features": features})
    plan = (
        await db.execute(select(Plan).where(Plan.id == sub.plan_id))
    ).scalar_one_or_none()
    return ok(
        {
            "subscription": _subscription_out(sub),
            "plan": _plan_out(plan) if plan else None,
            "features": features,
        }
    )


@router.post("/subscription", status_code=status.HTTP_201_CREATED)
async def create_subscription(
    body: SubscriptionIn, staff: CurrentStaff, db: DbSession, response: Response
):
    """為本租戶建立/切換訂閱(需 tenant.manage)。plan 必須是可存取的方案。

    付款門檻(P2):自助切換到「更貴的付費方案」(升級)必須先完成付款,不可免費
    即時解鎖旗艦(見下方 PAYMENT_REQUIRED)。免費方案(price==0)或降級 / 同級付費
    方案可直接切。
    """
    staff.require("tenant.manage")
    # 方案必須存在;可訂本租戶自有方案,或任何「公開且啟用中」的方案(平台/轉售者發行)。
    plan = (
        await db.execute(
            select(Plan).where(
                Plan.id == body.plan_id,
                Plan.deleted_at.is_(None),
                or_(
                    Plan.tenant_id == staff.tenant_id,
                    and_(Plan.is_public.is_(True), Plan.is_active.is_(True)),
                ),
            )
        )
    ).scalar_one_or_none()
    if not plan:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="方案不存在或不可用")

    # ------------------------------------------------------------------ #
    # 付款門檻(P2 修復):堵住「自助免費切到付費旗艦」漏洞。
    # 只要目標是付費方案(price>0),且屬「升級到比目前生效方案更貴」者,就必須
    # 先完成付款,不由本自助端點免費即時生效;免費方案或降級 / 同級可直接切。
    #   - Stripe 已啟用:引導改走 /billing/checkout 託管結帳,付款成功後由 webhook
    #     真正切換(見 stripe_webhook 依 metadata.plan_id 同步方案)。
    #   - Stripe 未啟用(目前狀態):回 PAYMENT_REQUIRED 提示聯繫平台開通,維持現方案。
    # 於此提前返回,故不會觸發下方「作廢舊訂閱(superseded)+ 建新訂閱」,現方案不變。
    # ------------------------------------------------------------------ #
    target_price = _plan_price(plan)
    if target_price > 0:
        current_price = await _effective_current_price(db, staff.tenant_id)
        if target_price > current_price:
            response.status_code = status.HTTP_402_PAYMENT_REQUIRED
            if stripe_gateway.is_enabled():
                return err(
                    "PAYMENT_REQUIRED",
                    "切換至付費方案需先完成付款,請改用結帳流程(/billing/checkout)完成付款,"
                    "付款成功後自動生效。",
                )
            return err(
                "PAYMENT_REQUIRED",
                "切換至付費方案需先完成付款;線上金流尚未啟用,請聯繫平台開通後再行升級。"
                "目前方案維持不變。",
            )

    # 安全:reseller_tenant_id **不信任前端**(否則任何租戶可自報掛進他人轉售儀表板)。
    # 轉售綁定只由轉售商招募時建立;切換方案時沿用該租戶現有訂閱的 reseller 關係。
    existing_reseller = (
        await db.execute(
            select(Subscription.reseller_tenant_id)
            .where(Subscription.tenant_id == staff.tenant_id, Subscription.deleted_at.is_(None))
            .order_by(Subscription.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    # 換方案前先作廢該租戶既有「現行(生效)」訂閱,確保每租戶至多一筆現行訂閱。
    # 否則同一租戶會累積多筆 active 訂閱,導致轉售端點下鑽 500(MultipleResultsFound)、
    # 總覽把同一下游重複列出並按歷史換方案次數重複計費。保留歷史列(soft-superseded)供稽核。
    superseded = (
        await db.execute(
            select(Subscription).where(
                Subscription.tenant_id == staff.tenant_id,
                Subscription.deleted_at.is_(None),
                Subscription.status.in_(EFFECTIVE_STATUSES),
            )
        )
    ).scalars().all()
    # 帳單設定(稅率 / VAT / 帳單地址)存於現行訂閱 meta.billing_profile,屬「租戶級」
    # 而非「單筆訂閱」概念;換方案會作廢舊訂閱、建新訂閱,故在此把它隨新訂閱帶過去,
    # 避免升 / 降級後稅務設定遺失。只搬 billing_profile,不動 stripe ids 等訂閱綁定。
    carried_meta: dict = {}
    for old in superseded:
        old.status = "superseded"
        old.canceled_at = func.now()
        if isinstance(old.meta, dict) and "billing_profile" in old.meta and "billing_profile" not in carried_meta:
            carried_meta["billing_profile"] = old.meta["billing_profile"]

    sub = Subscription(
        tenant_id=staff.tenant_id,
        plan_id=body.plan_id,
        reseller_tenant_id=existing_reseller,
        byo_key=body.byo_key,
        seats=body.seats,
        status="active",
        current_period_start=body.current_period_start,
        current_period_end=body.current_period_end,
        meta=carried_meta or None,
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return ok(_subscription_out(sub))


# --------------------------------------------------------------------------- #
# Stripe 收款(測試模式;卡號輸入全在 Stripe 託管結帳頁,我方不碰卡號)
# --------------------------------------------------------------------------- #
class CheckoutIn(BaseModel):
    plan_id: uuid.UUID
    success_url: str
    cancel_url: str


_STRIPE_DISABLED_MSG = "未設定 Stripe 金鑰(測試模式)"


def _merge_sub_meta(sub: Subscription, updates: dict) -> None:
    """read-merge-write 更新 Subscription.meta(過濾 None;重新指派以觸發 JSONB 更新)。"""
    meta = dict(sub.meta or {})
    for k, v in updates.items():
        if v is not None:
            meta[k] = v
    sub.meta = meta


@router.post("/checkout")
async def create_checkout(body: CheckoutIn, staff: CurrentStaff, db: DbSession):
    """建立 Stripe 訂閱型 Checkout Session,回 hosted url(admin;需 tenant.manage)。

    金鑰未設定時回 BILLING_STRIPE_DISABLED 並降級(不崩)。實際刷卡在 Stripe 託管頁,
    我方不碰卡號。若本租戶已有訂閱,把 checkout_session_id 併入其 meta 便於稽核。
    """
    staff.require("tenant.manage")
    if not stripe_gateway.is_enabled():
        return err("BILLING_STRIPE_DISABLED", _STRIPE_DISABLED_MSG)

    plan = (
        await db.execute(
            select(Plan).where(
                Plan.id == body.plan_id,
                Plan.tenant_id == staff.tenant_id,
                Plan.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if not plan:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="方案不存在或不可用")
    if (plan.price_cents or 0) <= 0 and (plan.price_monthly or 0) <= 0:
        return err("BILLING_PLAN_NOT_PAYABLE", "免費方案無需結帳")

    sub = await _active_subscription(db, staff.tenant_id)
    customer_id = (sub.meta or {}).get("stripe_customer_id") if sub else None

    try:
        session = await stripe_gateway.create_checkout_session(
            plan=plan,
            tenant_id=str(staff.tenant_id),
            success_url=body.success_url,
            cancel_url=body.cancel_url,
            customer_id=customer_id,
        )
    except stripe_gateway.StripeError as exc:
        return err("BILLING_STRIPE_ERROR", f"建立結帳工作階段失敗:{exc}")

    if sub and session.get("id"):
        _merge_sub_meta(sub, {"checkout_session_id": session["id"]})
        await db.commit()

    return ok({"url": session.get("url"), "session_id": session.get("id"), "plan_id": str(plan.id)})


@router.post("/stripe/webhook")
async def stripe_webhook(
    request: Request,
    db: DbSession,
    stripe_signature: Annotated[str | None, Header(alias="Stripe-Signature")] = None,
):
    """Stripe webhook(公開,無 JWT):驗簽後更新本地 Subscription 狀態與 stripe ids。

    處理 checkout.session.completed / customer.subscription.updated / .deleted。
    未設定 webhook 密鑰時回 BILLING_STRIPE_DISABLED;驗章失敗回 400。
    以事件 metadata 的 tenant_id 回關本地訂閱(不依賴 JSONB 查詢,DB 無關)。
    """
    payload = await request.body()
    secret = stripe_gateway.webhook_secret()
    if not secret:
        return err("BILLING_STRIPE_DISABLED", _STRIPE_DISABLED_MSG)

    event = stripe_gateway.verify_webhook(payload, stripe_signature, secret)
    if event is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="webhook 簽章驗證失敗")

    action = stripe_gateway.handle_event(event)
    if not action:
        return ok({"handled": False, "event_type": event.get("type")})

    tenant_id_raw = action.get("tenant_id")
    if not tenant_id_raw:
        return ok({"handled": False, "reason": "no tenant_id"})
    try:
        tenant_id = uuid.UUID(str(tenant_id_raw))
    except ValueError:
        return ok({"handled": False, "reason": "bad tenant_id"})

    sub = await _active_subscription(db, tenant_id)
    if not sub:
        return ok({"handled": False, "reason": "no subscription"})

    if action.get("status"):
        sub.status = action["status"]
    # 可選:若 metadata 帶 plan_id 且屬本租戶方案,同步切換方案
    plan_id_raw = action.get("plan_id")
    if plan_id_raw:
        try:
            new_plan_id = uuid.UUID(str(plan_id_raw))
        except ValueError:
            new_plan_id = None
        if new_plan_id and new_plan_id != sub.plan_id:
            exists = (
                await db.execute(
                    select(Plan.id).where(
                        Plan.id == new_plan_id, Plan.deleted_at.is_(None)
                    )
                )
            ).scalar_one_or_none()
            if exists:
                sub.plan_id = new_plan_id
    _merge_sub_meta(
        sub,
        {
            "stripe_customer_id": action.get("stripe_customer_id"),
            "stripe_subscription_id": action.get("stripe_subscription_id"),
            "checkout_session_id": action.get("checkout_session_id"),
        },
    )
    await db.commit()
    return ok({"handled": True, "event_type": action.get("event_type"), "status": sub.status})


# --------------------------------------------------------------------------- #
# 功能 gating(前端據此顯示鎖 / 升級提示)
# --------------------------------------------------------------------------- #
@router.get("/features")
async def get_features(staff: CurrentStaff, db: DbSession):
    """本租戶生效功能字典 + 功能目錄(名稱/型別/說明),供前端渲染。

    features:{feature_key: bool 或 數值上限(None=無限)};無訂閱視為 Free。
    catalog:每個功能鍵的顯示名稱、型別與說明。
    """
    features = await tenant_features(db, staff.tenant_id)
    return ok({"tenant_id": str(staff.tenant_id), "features": features, "catalog": FEATURE_CATALOG})


# --------------------------------------------------------------------------- #
# 用量與帳單
# --------------------------------------------------------------------------- #
@router.get("/usage")
async def usage_summary(staff: CurrentStaff, db: DbSession, start: StartQ = None, end: EndQ = None):
    """本租戶用量彙總(依 kind 加總 UsageRecord)。"""
    staff.require("tenant.manage")  # 財務資料:對齊寫入端,僅管理者可讀
    usage = await _usage_by_kind(db, [staff.tenant_id], start, end)
    return ok({"tenant_id": str(staff.tenant_id), "usage": usage})


@router.get("/invoice/summary")
async def invoice_summary(staff: CurrentStaff, db: DbSession, start: StartQ = None, end: EndQ = None):
    """帳單彙總:訂閱基礎費 + 依用量透明計價;BYO-Key 時排除自負成本。"""
    staff.require("tenant.manage")  # 財務資料:僅管理者可讀
    sub = await _active_subscription(db, staff.tenant_id)
    plan = None
    byo_key = False
    if sub:
        byo_key = sub.byo_key
        plan = (await db.execute(select(Plan).where(Plan.id == sub.plan_id))).scalar_one_or_none()
    usage = await _usage_by_kind(db, [staff.tenant_id], start, end)
    charges = estimate_charges(usage, plan, byo_key)
    return ok(
        {
            "tenant_id": str(staff.tenant_id),
            "plan": _plan_out(plan) if plan else None,
            "usage": usage,
            "charges": charges,
        }
    )


# --------------------------------------------------------------------------- #
# 白牌轉售儀表板
# --------------------------------------------------------------------------- #
async def _downstream_subscriptions(db: DbSession, reseller_tenant_id: uuid.UUID) -> list[Subscription]:
    """取得掛在此轉售者名下、每租戶「現行(生效)」的訂閱(每租戶至多一筆)。

    只取 status 屬 EFFECTIVE_STATUSES 且未刪除者,並依 started_at 由新到舊去重:
    即使 DB 仍存有歷史多筆(舊制換方案未作廢的舊列),同一下游也只列一次、不重複計費。
    """
    rows = (
        await db.execute(
            select(Subscription)
            .where(
                Subscription.reseller_tenant_id == reseller_tenant_id,
                Subscription.deleted_at.is_(None),
                Subscription.status.in_(EFFECTIVE_STATUSES),
            )
            .order_by(Subscription.started_at.desc())
        )
    ).scalars().all()
    latest_by_tenant: dict[uuid.UUID, Subscription] = {}
    for s in rows:
        latest_by_tenant.setdefault(s.tenant_id, s)
    return list(latest_by_tenant.values())


@router.get("/reseller/overview")
async def reseller_overview(staff: CurrentStaff, db: DbSession, start: StartQ = None, end: EndQ = None):
    """轉售者總覽:名下每個租戶的訂閱狀態、方案、用量與計費彙總。"""
    _require_reseller(staff)
    subs = await _downstream_subscriptions(db, staff.tenant_id)
    if not subs:
        return ok({"reseller_tenant_id": str(staff.tenant_id), "tenants": [], "totals": {}})

    plan_ids = {s.plan_id for s in subs}
    plans = {
        p.id: p
        for p in (await db.execute(select(Plan).where(Plan.id.in_(plan_ids)))).scalars().all()
    }
    # 批量載入下游租戶的名稱/啟用狀態(供清單顯示與停用/啟用操作)
    tenant_ids = {s.tenant_id for s in subs}
    ten_meta = {
        t.id: t
        for t in (await db.execute(select(Tenant).where(Tenant.id.in_(tenant_ids)))).scalars().all()
    }

    tenants_out = []
    aggregate_totals: dict[str, float] = {}
    for sub in subs:
        usage = await _usage_by_kind(db, [sub.tenant_id], start, end)
        for kind, qty in usage.items():
            aggregate_totals[kind] = aggregate_totals.get(kind, 0.0) + qty
        charges = estimate_charges(usage, plans.get(sub.plan_id), sub.byo_key)
        tmeta = ten_meta.get(sub.tenant_id)
        tenants_out.append(
            {
                "tenant_id": str(sub.tenant_id),
                "name": tmeta.name if tmeta else None,
                "slug": tmeta.slug if tmeta else None,
                "is_active": tmeta.is_active if tmeta else None,
                "subscription": _subscription_out(sub),
                "plan": _plan_out(plans[sub.plan_id]) if sub.plan_id in plans else None,
                "usage": usage,
                "charges": charges,
            }
        )
    return ok(
        {
            "reseller_tenant_id": str(staff.tenant_id),
            "tenant_count": len(tenants_out),
            "tenants": tenants_out,
            "totals": aggregate_totals,
        }
    )


@router.get("/reseller/tenants/{tenant_id}/usage")
async def reseller_tenant_usage(
    tenant_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
    start: StartQ = None,
    end: EndQ = None,
):
    """轉售者下鑽單一名下租戶的用量/帳單(先驗證該租戶確在其名下)。"""
    _require_reseller(staff)
    # 收斂到該租戶「現行(生效)」訂閱:取最新一筆,即使 DB 仍存多筆也不會 MultipleResultsFound。
    sub = (
        await db.execute(
            select(Subscription)
            .where(
                Subscription.tenant_id == tenant_id,
                Subscription.reseller_tenant_id == staff.tenant_id,
                Subscription.deleted_at.is_(None),
                Subscription.status.in_(EFFECTIVE_STATUSES),
            )
            .order_by(Subscription.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not sub:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="該租戶不在你名下")
    plan = (await db.execute(select(Plan).where(Plan.id == sub.plan_id))).scalar_one_or_none()
    usage = await _usage_by_kind(db, [tenant_id], start, end)
    charges = estimate_charges(usage, plan, sub.byo_key)
    return ok(
        {
            "tenant_id": str(tenant_id),
            "subscription": _subscription_out(sub),
            "plan": _plan_out(plan) if plan else None,
            "usage": usage,
            "charges": charges,
        }
    )


# --------------------------------------------------------------------------- #
# 轉售商自助招募 / 管理下游租戶
# --------------------------------------------------------------------------- #
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ResellerOnboardIn(BaseModel):
    """轉售商開通下游租戶的輸入。reseller_tenant_id 不由前端提供,一律取自 JWT。"""

    name: str = Field(..., min_length=1, max_length=200, description="下游租戶名稱")
    admin_email: str = Field(..., description="下游租戶第一個管理員 email")
    admin_password: str = Field(..., min_length=6, description="下游管理員初始密碼(≥6)")
    admin_display_name: str | None = None
    slug: str | None = Field(default=None, description="子網域 slug(未給則由名稱衍生)")
    branding: dict | None = None


@router.post("/reseller/tenants", status_code=status.HTTP_201_CREATED)
async def reseller_onboard(body: ResellerOnboardIn, staff: CurrentStaff, db: DbSession):
    """轉售商一鍵開通一個**掛在自己名下**的下游租戶(含 admin 坐席與 Free 訂閱)。

    安全:``reseller_tenant_id`` 取自轉售商自身 JWT(``staff.tenant_id``),
    故轉售商只能把新租戶開在自己名下,無法冒充他人。
    """
    _require_reseller(staff)
    email = body.admin_email.strip()
    if not _EMAIL_RE.match(email):
        # 錯誤輸入屬硬性 4xx;原本走 err() 卻被路由的 201 狀態碼蓋掉(誤回 201)。
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="管理員 email 格式不正確")
    try:
        tenant, admin = await provisioning.provision_tenant(
            db,
            name=body.name,
            admin_email=email,
            admin_password=body.admin_password,
            admin_display_name=body.admin_display_name,
            slug=body.slug,
            reseller_tenant_id=staff.tenant_id,  # 掛在轉售商自己名下(不信任前端)
            branding=body.branding,
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return ok(
        {
            "tenant": {
                "id": str(tenant.id),
                "name": tenant.name,
                "slug": tenant.slug,
                "is_active": tenant.is_active,
            },
            "admin": {
                "staff_id": str(admin.id),
                "email": admin.email,
                "display_name": admin.display_name,
            },
        }
    )


async def _owned_downstream_tenant(db: DbSession, reseller_tenant_id, tenant_id) -> bool:
    """確認 tenant_id 確為該轉售商名下的下游(以訂閱關係驗證)。"""
    return (
        await db.execute(
            select(Subscription.id)
            .where(
                Subscription.tenant_id == tenant_id,
                Subscription.reseller_tenant_id == reseller_tenant_id,
                Subscription.deleted_at.is_(None),
            )
            .limit(1)  # 多筆訂閱時只驗證存在性,避免 MultipleResultsFound → 500
        )
    ).scalar_one_or_none() is not None


async def _set_downstream_active(tenant_id: uuid.UUID, staff, db, active: bool):
    _require_reseller(staff)
    if not await _owned_downstream_tenant(db, staff.tenant_id, tenant_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="該租戶不在你名下")
    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="租戶不存在")
    tenant.is_active = active
    await db.commit()
    return ok({"tenant_id": str(tenant_id), "is_active": active})


@router.post("/reseller/tenants/{tenant_id}/suspend")
async def reseller_suspend_tenant(tenant_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """停用名下下游租戶(其坐席將無法登入)。"""
    return await _set_downstream_active(tenant_id, staff, db, False)


@router.post("/reseller/tenants/{tenant_id}/activate")
async def reseller_activate_tenant(tenant_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """重新啟用名下下游租戶。"""
    return await _set_downstream_active(tenant_id, staff, db, True)


# --------------------------------------------------------------------------- #
# 帳單設定(稅率 / VAT / 帳單地址)—— 存於現行訂閱 meta.billing_profile(既有 JSONB,免 ALTER)
# --------------------------------------------------------------------------- #
class BillingSettingsIn(BaseModel):
    """租戶帳單 / 稅務設定。tax_rate 為百分比(例 20 = 20%);0 表免稅。"""

    tax_rate: float = Field(default=0.0, ge=0, le=100, description="稅率(百分比,0–100)")
    tax_label: str | None = Field(default=None, max_length=60, description="稅名(例 VAT / 消費稅)")
    vat_number: str | None = Field(default=None, max_length=60, description="VAT / 統一編號")
    billing_address: dict | None = Field(default=None, description="帳單地址(自由結構)")


def _billing_profile_out(profile: dict) -> dict:
    """把 meta.billing_profile 正規化成穩定的回應形狀(缺欄回預設)。"""
    profile = profile if isinstance(profile, dict) else {}
    return {
        "tax_rate": float(profile.get("tax_rate", 0) or 0),
        "tax_label": profile.get("tax_label"),
        "vat_number": profile.get("vat_number"),
        "billing_address": profile.get("billing_address") or {},
    }


async def _billing_profile(db: DbSession, tenant_id: uuid.UUID) -> dict:
    """讀租戶帳單設定(存於現行 / 最新一筆訂閱的 meta.billing_profile);無則回空。"""
    sub = await _active_subscription(db, tenant_id)
    if sub and isinstance(sub.meta, dict):
        bp = sub.meta.get("billing_profile")
        if isinstance(bp, dict):
            return bp
    return {}


@router.get("/settings")
async def get_billing_settings(staff: CurrentStaff, db: DbSession):
    """取本租戶帳單 / 稅務設定(供發票產出計稅與前端表單回填)。"""
    staff.require("tenant.manage")  # 稅務 / VAT / 帳單地址:僅管理者可讀
    profile = await _billing_profile(db, staff.tenant_id)
    return ok({"tenant_id": str(staff.tenant_id), "settings": _billing_profile_out(profile)})


@router.put("/settings")
async def update_billing_settings(body: BillingSettingsIn, staff: CurrentStaff, db: DbSession):
    """更新本租戶帳單 / 稅務設定(需 settings.manage)。

    設定屬租戶級,存於現行訂閱的 meta.billing_profile(既有 JSONB,免對既有表 ALTER)。
    尚無任何訂閱時無處落腳,回明確錯誤引導先訂閱(新租戶開通時已種 Free 訂閱)。
    """
    staff.require("settings.manage")
    sub = await _active_subscription(db, staff.tenant_id)
    if sub is None:
        return err("BILLING_NO_SUBSCRIPTION", "尚無訂閱可掛載帳單設定,請先建立訂閱後再設定稅務資訊。")
    profile = {
        "tax_rate": float(body.tax_rate or 0),
        "tax_label": body.tax_label,
        "vat_number": body.vat_number,
        "billing_address": body.billing_address or {},
    }
    _merge_sub_meta(sub, {"billing_profile": profile})
    await db.commit()
    return ok({"tenant_id": str(staff.tenant_id), "settings": _billing_profile_out(profile)})


# --------------------------------------------------------------------------- #
# 優惠券 / 折扣碼
# --------------------------------------------------------------------------- #
def _coupon_out(c: Coupon) -> dict:
    return {
        "id": str(c.id),
        "code": c.code,
        "percent_off": c.percent_off,
        "amount_off_cents": c.amount_off_cents,
        "currency": c.currency,
        "valid_until": c.valid_until,
        "max_redemptions": c.max_redemptions,
        "redeemed_count": c.redeemed_count,
        "is_active": c.is_active,
        "stripe_coupon_id": c.stripe_coupon_id,
    }


def _coupon_redeemable(c: Coupon, now: datetime) -> tuple[bool, str | None]:
    """優惠券此刻是否可套用(純判斷)。回 (ok, 錯誤碼)。"""
    if not c.is_active:
        return False, "COUPON_INACTIVE"
    if c.valid_until is not None and c.valid_until < now:
        return False, "COUPON_EXPIRED"
    if c.max_redemptions is not None and (c.redeemed_count or 0) >= c.max_redemptions:
        return False, "COUPON_EXHAUSTED"
    return True, None


def _coupon_discount_cents(subtotal_cents: int, c: Coupon | None) -> int:
    """依優惠券對小計算折扣(分);上限為小計本身、下限為 0。純函式。"""
    if c is None or subtotal_cents <= 0:
        return 0
    if c.percent_off:
        discount = int(round(subtotal_cents * int(c.percent_off) / 100.0))
    elif c.amount_off_cents:
        discount = int(c.amount_off_cents)
    else:
        discount = 0
    return max(0, min(discount, subtotal_cents))


class CouponIn(BaseModel):
    code: str = Field(..., min_length=1, max_length=60)
    percent_off: int | None = Field(default=None, ge=1, le=100, description="百分比折扣(1–100)")
    amount_off_cents: int | None = Field(default=None, ge=1, description="固定金額折扣(分)")
    currency: str = "USD"
    valid_until: datetime | None = None
    max_redemptions: int | None = Field(default=None, ge=1)
    is_active: bool = True


@router.post("/coupons", status_code=status.HTTP_201_CREATED)
async def create_coupon(body: CouponIn, staff: CurrentStaff, db: DbSession, response: Response):
    """建立優惠券(需 settings.manage)。percent_off 與 amount_off_cents 必須恰選其一。

    Stripe 啟用且閘道具備 create_coupon 能力時同步為 Stripe coupon(code-ready);
    未啟用則純內部記錄,套用發票時仍完整計算折扣。
    """
    staff.require("settings.manage")
    if bool(body.percent_off) == bool(body.amount_off_cents):
        response.status_code = status.HTTP_400_BAD_REQUEST
        return err("COUPON_INVALID_DISCOUNT", "percent_off 與 amount_off_cents 必須恰選其一。")

    code = body.code.strip()
    dup = (
        await db.execute(
            select(Coupon.id).where(
                Coupon.tenant_id == staff.tenant_id,
                Coupon.code == code,
                Coupon.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if dup is not None:
        response.status_code = status.HTTP_409_CONFLICT
        return err("COUPON_DUPLICATE", "折扣碼已存在。")

    coupon = Coupon(
        tenant_id=staff.tenant_id,
        code=code,
        percent_off=body.percent_off,
        amount_off_cents=body.amount_off_cents,
        currency=body.currency,
        valid_until=body.valid_until,
        max_redemptions=body.max_redemptions,
        is_active=body.is_active,
    )
    # code-ready:Stripe 啟用且閘道提供 create_coupon 時同步;否則純內部記錄。
    if stripe_gateway.is_enabled():
        creator = getattr(stripe_gateway, "create_coupon", None)
        if callable(creator):
            try:
                synced = await creator(coupon=coupon, tenant_id=str(staff.tenant_id))
                if isinstance(synced, dict) and synced.get("id"):
                    coupon.stripe_coupon_id = str(synced["id"])
            except stripe_gateway.StripeError:
                pass  # 同步失敗不阻斷內部建立(降級為純內部記錄)

    db.add(coupon)
    await db.commit()
    await db.refresh(coupon)
    return ok(_coupon_out(coupon))


@router.get("/coupons")
async def list_coupons(staff: CurrentStaff, db: DbSession, include_inactive: bool = True):
    """列出本租戶優惠券(預設含停用;可帶 include_inactive=false 只看啟用中)。"""
    staff.require("tenant.manage")  # 折扣碼 / 金額屬敏感:對齊建立端,僅管理者可讀
    conds = [Coupon.tenant_id == staff.tenant_id, Coupon.deleted_at.is_(None)]
    if not include_inactive:
        conds.append(Coupon.is_active.is_(True))
    rows = (
        await db.execute(select(Coupon).where(and_(*conds)).order_by(Coupon.created_at.desc()))
    ).scalars().all()
    return ok({"coupons": [_coupon_out(c) for c in rows]})


# --------------------------------------------------------------------------- #
# 發票產出 / 列表 / 明細
# --------------------------------------------------------------------------- #
_INVOICE_STATUSES = frozenset({"draft", "open", "paid", "void"})


def _invoice_out(inv: Invoice) -> dict:
    return {
        "id": str(inv.id),
        "number": inv.number,
        "tenant_id": str(inv.tenant_id),
        "period_start": inv.period_start,
        "period_end": inv.period_end,
        "line_items": inv.line_items or [],
        "subtotal_cents": inv.subtotal_cents,
        "discount_cents": inv.discount_cents,
        "tax_cents": inv.tax_cents,
        "total_cents": inv.total_cents,
        "currency": inv.currency,
        "status": inv.status,
        "issued_at": inv.issued_at,
        "paid_at": inv.paid_at,
        "stripe_invoice_id": inv.stripe_invoice_id,
        "meta": inv.meta or {},
    }


def _compute_tax_cents(taxable_cents: int, tax_rate: float | int | None) -> int:
    """對可課稅金額(分)依稅率(百分比)算稅額(分,四捨五入)。純函式。"""
    rate = float(tax_rate or 0)
    if rate <= 0 or taxable_cents <= 0:
        return 0
    return int(round(taxable_cents * rate / 100.0))


def _invoice_line_items(charges: dict) -> list[dict]:
    """把 estimate_charges 的結果(貨幣主單位)攤成發票逐項明細(金額轉為分)。"""
    items: list[dict] = [
        {
            "type": "base",
            "kind": "base_fee",
            "description": "方案基礎費",
            "amount_cents": int(round(float(charges.get("base_fee", 0) or 0) * 100)),
        }
    ]
    for li in charges.get("line_items", []):
        if (li.get("billable_quantity", 0) or 0) > 0 or (li.get("amount", 0) or 0) > 0:
            items.append(
                {
                    "type": "metered",
                    "kind": li.get("kind"),
                    "quantity": li.get("quantity"),
                    "included": li.get("included"),
                    "billable_quantity": li.get("billable_quantity"),
                    "unit_price": li.get("unit_price"),
                    "amount_cents": int(round(float(li.get("amount", 0) or 0) * 100)),
                    "self_funded": bool(li.get("self_funded")),
                }
            )
    return items


async def _next_invoice_number(db: DbSession, tenant_id: uuid.UUID, now: datetime) -> str:
    """產生同租戶內遞增單號 INV-YYYYMM-NNNN。

    以現有發票數 +1 編號;唯一性由 (tenant_id, number) 約束保底(競態時極少數重號
    會由 DB 約束擋下,呼叫端可重試)。含軟刪除計數以避免號碼回收。
    """
    count = (
        await db.execute(select(func.count(Invoice.id)).where(Invoice.tenant_id == tenant_id))
    ).scalar_one()
    return f"INV-{now:%Y%m}-{int(count) + 1:04d}"


class GenerateInvoiceIn(BaseModel):
    start: datetime | None = None
    end: datetime | None = None
    coupon_code: str | None = Field(default=None, description="套用的優惠券碼(選填)")
    status: str = Field(default="open", description="產出狀態:draft / open")


@router.post("/invoices/generate", status_code=status.HTTP_201_CREATED)
async def generate_invoice(
    body: GenerateInvoiceIn, staff: CurrentStaff, db: DbSession, response: Response
):
    """依「用量 + 方案」產出一張發票(需 tenant.manage)。

    計算複用 usage.estimate_charges(與 /invoice/summary 同一套透明計價),再:
    套用優惠券折扣 → 依租戶稅率計稅 → 落庫為 Invoice。Stripe 啟用且閘道具備
    create_invoice 能力時同步開票(code-ready);否則純內部記錄。
    """
    staff.require("tenant.manage")
    now = datetime.now(timezone.utc)

    sub = await _active_subscription(db, staff.tenant_id)
    plan = None
    byo_key = False
    if sub is not None:
        byo_key = sub.byo_key
        plan = (await db.execute(select(Plan).where(Plan.id == sub.plan_id))).scalar_one_or_none()

    usage = await _usage_by_kind(db, [staff.tenant_id], body.start, body.end)
    charges = estimate_charges(usage, plan, byo_key)
    currency = charges["currency"]
    # subtotal 直接由逐項明細的分值加總得出(明細與小計同源),避免「先加總再進位」與
    # 「各項先進位再加總」在次分位分歧、導致明細合計 ≠ subtotal 而無法對帳。
    line_items = _invoice_line_items(charges)
    subtotal_cents = sum(int(li.get("amount_cents", 0) or 0) for li in line_items)

    # 優惠券(選填):存在則驗證可套用,計折扣;兌換次數於落庫時 +1。
    coupon: Coupon | None = None
    if body.coupon_code:
        coupon = (
            await db.execute(
                # with_for_update:對該優惠券列加行鎖,序列化並發兌換,避免兩個請求都讀到
                # count=max-1、各自 +1 而越過 max_redemptions(read-modify-write 競態)。
                select(Coupon)
                .where(
                    Coupon.tenant_id == staff.tenant_id,
                    Coupon.code == body.coupon_code.strip(),
                    Coupon.deleted_at.is_(None),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if coupon is None:
            response.status_code = status.HTTP_404_NOT_FOUND
            return err("COUPON_NOT_FOUND", "找不到此優惠券。")
        redeemable, reason = _coupon_redeemable(coupon, now)
        if not redeemable:
            response.status_code = status.HTTP_400_BAD_REQUEST
            return err(reason or "COUPON_INVALID", "優惠券不可用(已停用 / 過期 / 兌換次數用罄)。")
        # 固定金額券必須與發票幣別一致:amount_off_cents 是「該幣別的分」,跨幣別直接
        # 照搬分值會造成金額 / 語意錯誤(percent_off 與幣別無關,不受限)。
        if coupon.amount_off_cents and coupon.currency and coupon.currency != currency:
            response.status_code = status.HTTP_400_BAD_REQUEST
            return err(
                "COUPON_CURRENCY_MISMATCH",
                f"優惠券幣別({coupon.currency})與發票幣別({currency})不符。",
            )

    discount_cents = _coupon_discount_cents(subtotal_cents, coupon)
    taxable_cents = subtotal_cents - discount_cents

    profile = _billing_profile_out(await _billing_profile(db, staff.tenant_id))
    tax_cents = _compute_tax_cents(taxable_cents, profile["tax_rate"])
    total_cents = taxable_cents + tax_cents

    inv_status = body.status if body.status in ("draft", "open") else "open"
    # 兌換計數:僅在「正式產出(open)」時消耗一次兌換。draft 為預覽,可反覆重生,
    # 不應燒掉 max_redemptions。是否已計數記進 meta,供後續狀態轉換回滾 / 補計。
    coupon_redeemed = coupon is not None and inv_status != "draft"
    number = await _next_invoice_number(db, staff.tenant_id, now)
    inv = Invoice(
        tenant_id=staff.tenant_id,
        number=number,
        period_start=body.start,
        period_end=body.end,
        line_items=line_items,
        subtotal_cents=subtotal_cents,
        discount_cents=discount_cents,
        tax_cents=tax_cents,
        total_cents=total_cents,
        currency=currency,
        status=inv_status,
        issued_at=now,
        meta={
            "byo_key": byo_key,
            "plan_code": getattr(plan, "code", None) if plan else None,
            "coupon_code": coupon.code if coupon else None,
            "coupon_redeemed": coupon_redeemed,
            "tax_rate": profile["tax_rate"],
            "tax_label": profile["tax_label"],
            "vat_number": profile["vat_number"],
            "billing_address": profile["billing_address"],
        },
    )

    # code-ready:Stripe 啟用且閘道提供 create_invoice 時同步開票;否則純內部記錄。
    if stripe_gateway.is_enabled():
        creator = getattr(stripe_gateway, "create_invoice", None)
        if callable(creator):
            try:
                synced = await creator(invoice=inv, tenant_id=str(staff.tenant_id))
                if isinstance(synced, dict) and synced.get("id"):
                    inv.stripe_invoice_id = str(synced["id"])
            except stripe_gateway.StripeError:
                pass  # 同步失敗不阻斷內部產出(降級為純內部記錄)

    if coupon_redeemed:
        coupon.redeemed_count = (coupon.redeemed_count or 0) + 1

    db.add(inv)
    await db.commit()
    await db.refresh(inv)
    return ok(_invoice_out(inv))


@router.get("/invoices")
async def list_invoices(staff: CurrentStaff, db: DbSession, limit: int = 50):
    """列出本租戶發票(新到舊)。"""
    staff.require("tenant.manage")  # 發票金額屬財務資料:僅管理者可讀
    limit = max(1, min(int(limit), 200))
    rows = (
        await db.execute(
            select(Invoice)
            .where(Invoice.tenant_id == staff.tenant_id, Invoice.deleted_at.is_(None))
            .order_by(Invoice.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return ok({"invoices": [_invoice_out(inv) for inv in rows]})


@router.get("/invoices/{invoice_id}")
async def get_invoice(invoice_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """取單張發票明細(租戶隔離)。"""
    staff.require("tenant.manage")  # 發票金額屬財務資料:僅管理者可讀
    inv = (
        await db.execute(
            select(Invoice).where(
                Invoice.id == invoice_id,
                Invoice.tenant_id == staff.tenant_id,
                Invoice.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if inv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="發票不存在")
    return ok(_invoice_out(inv))


class InvoiceStatusIn(BaseModel):
    status: str = Field(..., description="draft / open / paid / void")


@router.post("/invoices/{invoice_id}/status")
async def set_invoice_status(
    invoice_id: uuid.UUID, body: InvoiceStatusIn, staff: CurrentStaff, db: DbSession, response: Response
):
    """更新發票狀態(需 tenant.manage)。標記 paid 時回填 paid_at。

    內部記錄模式下,此端點即為「收款 / 作廢」的落點;Stripe 啟用時真正收款仍由
    webhook 驅動,此端點可作為人工調整 / 對帳補登。
    """
    staff.require("tenant.manage")
    if body.status not in _INVOICE_STATUSES:
        response.status_code = status.HTTP_400_BAD_REQUEST
        return err("INVOICE_INVALID_STATUS", "狀態須為 draft / open / paid / void 之一。")
    inv = (
        await db.execute(
            select(Invoice).where(
                Invoice.id == invoice_id,
                Invoice.tenant_id == staff.tenant_id,
                Invoice.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if inv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="發票不存在")

    # 優惠券兌換計數的補記 / 回滾(對齊 generate_invoice 的 draft 不計數規則):
    #   - 轉入正式狀態(open/paid)且尚未計數 → 補計一次(涵蓋 draft→open 落地);
    #   - 轉為 void 且先前已計數 → 回滾一次(釋放 max_redemptions 名額)。
    # 以 meta.coupon_redeemed 為單一事實來源,確保同一發票不重複增減。JSONB 需整包
    # 重指派才會被 SQLAlchemy 追蹤髒值。**在變更狀態前先處理**,因為 draft→open 補計
    # 需重新校驗 max_redemptions,不可用時要能拒絕整個狀態轉換。
    now = datetime.now(timezone.utc)
    meta = dict(inv.meta or {})
    code = meta.get("coupon_code")
    counted = bool(meta.get("coupon_redeemed"))
    promoting = body.status in ("open", "paid") and not counted
    voiding = body.status == "void" and counted
    if code and (promoting or voiding):
        coupon = (
            await db.execute(
                select(Coupon)
                .where(
                    Coupon.tenant_id == staff.tenant_id,
                    Coupon.code == code,
                    Coupon.deleted_at.is_(None),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if coupon is not None:
            if voiding:
                coupon.redeemed_count = max(0, (coupon.redeemed_count or 0) - 1)
                meta["coupon_redeemed"] = False
                inv.meta = meta
            else:
                # draft→open/paid 補計前**重新校驗可兌換性**:否則可先產任意多張 draft
                # (draft 不計數),再逐一 promote 到 open,每次無腦 +1 → 繞過 max_redemptions。
                redeemable, reason = _coupon_redeemable(coupon, now)
                if not redeemable:
                    response.status_code = status.HTTP_400_BAD_REQUEST
                    return err(
                        reason or "COUPON_INVALID",
                        "優惠券已不可用(停用 / 過期 / 兌換次數用罄),無法將此發票轉為正式。",
                    )
                coupon.redeemed_count = (coupon.redeemed_count or 0) + 1
                meta["coupon_redeemed"] = True
                inv.meta = meta

    inv.status = body.status
    if body.status == "paid" and inv.paid_at is None:
        inv.paid_at = now

    await db.commit()
    await db.refresh(inv)
    return ok(_invoice_out(inv))
