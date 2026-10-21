"""M11 報表 + M12 計費/白牌轉售的資料模型。

三張表:
- ``UsageRecord``:計量事件明細(由 app/services/usage.py 的 record_usage 寫入),
  是所有用量帳單彙總的單一真實來源(single source of truth)。
- ``Plan``:訂閱方案(平台或轉售者自訂),含基礎月費與各計量單價/額度。
- ``Subscription``:租戶訂閱關係;透過 ``reseller_tenant_id`` 記錄「此租戶由哪個
  轉售者租戶所轉售」,讓白牌轉售儀表板可跨其名下租戶彙總(仍受角色控管)。

設計取捨(見護城河:白牌轉售 / BYO-Key / 透明計費):
- BYO-Key 情境下 LLM token 成本歸租戶自負,故 ``Subscription.byo_key`` 為真時,
  計費彙總會排除 llm_tokens 這類成本,平台只收服務費 / 坐席數 / 對話數。
- 單價與額度放在 ``Plan`` 的 JSONB(``unit_prices`` / ``limits``),可配置、免改碼。
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class UsageRecord(Base, TenantScopedMixin):
    """單筆計量事件。TenantScopedMixin 已提供 id / tenant_id / 時戳 / 軟刪除。

    ``kind`` 例:llm_tokens、ai_reply、session、agent_seat、message …(見 usage.py 常數)。
    ``quantity`` 用 Numeric 以同時容納大整數(token 數)與小數;彙總時 SUM 之。
    ``recorded_at`` 為事件時間,獨立於 created_at,供報表/帳單依時間區間過濾。
    """

    __tablename__ = "usage_record"

    kind: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    quantity: Mapped[float] = mapped_column(Numeric(24, 6), nullable=False, default=0)
    # 額外脈絡:session_id、staff_id、model、provider、price_snapshot … 皆放這
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    recorded_at: Mapped["DateTime"] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )


class Plan(Base, TenantScopedMixin):
    """訂閱方案。tenant_id = 發行此方案的平台 / 轉售者租戶(轉售者可自訂白牌方案)。

    - ``price_cents``:週期基礎費(以分為單位,避免浮點誤差)。
    - ``billing_period``:monthly | yearly。
    - ``unit_prices``:各 kind 的計量單價(以貨幣「主單位」計,例 0.000002),供超量/透明計費。
    - ``limits``:額度設定,例 {"max_agents": 5, "included": {"ai_reply": 1000}}。
    """

    __tablename__ = "plan"
    # 方案代碼在同一發行租戶內唯一
    __table_args__ = (UniqueConstraint("tenant_id", "code", name="uq_plan_tenant_code"),)

    code: Mapped[str] = mapped_column(String(60), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 月費(以分為單位);功能 gating 的方案陳列以此顯示,計費彙總仍用 price_cents。
    # 種預設方案時兩者設為一致;分開保留以免動到既有 invoice 計價邏輯。
    price_monthly: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(10), nullable=False, default="USD")
    billing_period: Mapped[str] = mapped_column(String(20), nullable=False, default="monthly")
    # 功能開關/上限:{feature_key: true/false 或 數值上限}。見 app/services/plans.py 功能目錄。
    features: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    limits: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    unit_prices: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # 是否對外公開陳列(GET /plans 只回 is_public 的方案);內部/客製方案設 False。
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # 陳列排序(小到大);同價位方案的顯示先後。
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class Subscription(Base, TenantScopedMixin):
    """租戶訂閱關係。tenant_id = 被訂閱(付費使用)的租戶。

    ``reseller_tenant_id`` 指向轉售者租戶;白牌轉售儀表板據此跨「其名下租戶」彙總。
    ``byo_key`` 為真代表該租戶自帶 LLM 金鑰、LLM 成本自負,計費以服務費/坐席/對話為主。
    """

    __tablename__ = "subscription"

    plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("plan.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    # 轉售者(本身也是一個 tenant);null = 平台直營
    reseller_tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenant.id", ondelete="SET NULL"), index=True, nullable=True
    )
    # status: active | trialing | past_due | canceled
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active", index=True)
    byo_key: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    seats: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    started_at: Mapped["DateTime"] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    current_period_start: Mapped["DateTime | None"] = mapped_column(DateTime(timezone=True), nullable=True)
    current_period_end: Mapped["DateTime | None"] = mapped_column(DateTime(timezone=True), nullable=True)
    canceled_at: Mapped["DateTime | None"] = mapped_column(DateTime(timezone=True), nullable=True)
    # 訂閱脈絡 JSONB。除既有 stripe ids / checkout_session_id 外,亦承載本租戶的
    # 「帳單設定」(billing_profile:稅率 / VAT 號 / 帳單地址),避免為稅務欄位再對
    # 既有表 ALTER;換方案時由 billing.py 的 create_subscription 隨新訂閱一併帶過去。
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


# --------------------------------------------------------------------------- #
# 發票 / 優惠券(對標 LiveChat 計費;Stripe 未啟用時以內部記錄完整運作)
# --------------------------------------------------------------------------- #
class Invoice(Base, TenantScopedMixin):
    """一張已產出的帳單。TenantScopedMixin 已提供 id / tenant_id / 時戳 / 軟刪除。

    金額一律以「分」(整數)存放,避免浮點誤差;產出時複用 usage.estimate_charges
    的基礎費 + 用量計價,套用優惠券折扣後再依租戶稅率算稅。

    - ``number``:人類可讀單號(同租戶內唯一),格式 INV-YYYYMM-NNNN。
    - ``line_items``:逐項明細(JSONB),含基礎費 / 各計量 kind / 金額(分)。
    - ``subtotal_cents``:基礎費 + 用量小計(未扣折扣、未加稅)。
    - ``discount_cents``:套用優惠券後的折扣(≤ subtotal)。
    - ``tax_cents``:對 (subtotal - discount) 依租戶稅率計算。
    - ``total_cents``:subtotal - discount + tax。
    - ``status``:draft / open / paid / void。
    - ``stripe_invoice_id``:Stripe 啟用且成功同步時回填;否則為 None(純內部記錄)。
    """

    __tablename__ = "invoice"
    # 單號在同一租戶內唯一(跨租戶可重號,租戶隔離下互不干擾)
    __table_args__ = (UniqueConstraint("tenant_id", "number", name="uq_invoice_tenant_number"),)

    number: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    period_start: Mapped["DateTime | None"] = mapped_column(DateTime(timezone=True), nullable=True)
    period_end: Mapped["DateTime | None"] = mapped_column(DateTime(timezone=True), nullable=True)
    line_items: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    subtotal_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    discount_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tax_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(10), nullable=False, default="USD")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", index=True)
    issued_at: Mapped["DateTime | None"] = mapped_column(DateTime(timezone=True), nullable=True)
    paid_at: Mapped["DateTime | None"] = mapped_column(DateTime(timezone=True), nullable=True)
    # Stripe 開票同步後的發票 id(未啟用 / 未同步時為 None,不影響內部運作)
    stripe_invoice_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # 快照:優惠券碼 / 稅率 / VAT 號 / 帳單地址等產出時的脈絡,供稽核與明細顯示
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


class Coupon(Base, TenantScopedMixin):
    """優惠券 / 折扣碼。TenantScopedMixin 已提供 id / tenant_id / 時戳 / 軟刪除。

    折扣二擇一:``percent_off``(1–100 的百分比)或 ``amount_off_cents``(固定金額,分)。
    產出發票時據此對小計計算折扣;Stripe 啟用時亦可同步為 Stripe coupon(code-ready)。

    - ``valid_until``:到期時間(None = 不設期限)。
    - ``max_redemptions``:可兌換總次數上限(None = 不限);``redeemed_count`` 為已兌換次數。
    - ``is_active``:停用後不可再套用。
    """

    __tablename__ = "coupon"
    # 折扣碼在同一租戶內唯一
    __table_args__ = (UniqueConstraint("tenant_id", "code", name="uq_coupon_tenant_code"),)

    code: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    # 百分比折扣(1–100);與 amount_off_cents 二擇一
    percent_off: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 固定金額折扣(以分為單位);與 percent_off 二擇一
    amount_off_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    currency: Mapped[str] = mapped_column(String(10), nullable=False, default="USD")
    valid_until: Mapped["DateTime | None"] = mapped_column(DateTime(timezone=True), nullable=True)
    max_redemptions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    redeemed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Stripe 同步後的 coupon id(code-ready;未啟用 / 未同步時為 None)
    stripe_coupon_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
