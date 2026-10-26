"""M1 tenancy + M2 iam 服務層。

集中放本模組共用的商業邏輯:
- 預設權限碼種子清單與 per-tenant 種子函式。
- BYO-Key(llm_config)寫入後回傳時的金鑰遮罩。
- 租戶範圍取物件、分頁等小工具。
- 認證因子變更時撤銷既發 access token(``bump_token_version`` / ``mark_password_changed``)。

路由層(app/api/v1/tenancy.py、app/api/v1/iam.py)只依賴這裡的函式簽名。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.iam import Permission, Role, Staff, role_permission

# ---------------------------------------------------------------------------
# 預設權限碼種子清單(code, 說明)。新租戶建立時可一次寫入,
# 之後仍可透過 Permission CRUD 自訂增補。碼採「模組.動作」命名。
# ---------------------------------------------------------------------------
DEFAULT_PERMISSIONS: list[tuple[str, str]] = [
    # 租戶與組織管理
    ("tenant.view", "檢視租戶與白牌設定"),
    ("tenant.manage", "管理租戶、白牌與 LLM 設定"),
    ("organization.view", "檢視組織樹"),
    ("organization.manage", "管理組織/部門"),
    # 坐席與 RBAC
    ("staff.view", "檢視坐席"),
    ("staff.manage", "新增/編輯/啟停用坐席、改密碼"),
    ("role.view", "檢視角色與權限"),
    ("role.manage", "管理角色、指派權限與角色"),
    ("audit.view", "檢視稽核日誌"),
    ("skillgroup.view", "檢視技能組"),
    ("skillgroup.manage", "管理技能組與成員"),
    # 會話與運營(供他模組權限檢查引用)
    ("conversation.view", "檢視會話"),
    ("conversation.assign", "指派/認領會話"),
    ("conversation.transfer", "轉接會話(handoff)"),
    ("conversation.close", "關閉會話"),
    ("knowledge.view", "檢視知識庫"),
    ("knowledge.manage", "管理知識庫內容"),
    ("ticket.view", "檢視工單"),
    ("ticket.manage", "管理工單"),
    ("quality.view", "檢視質檢/CSAT"),
    ("quality.manage", "執行質檢標註與干預"),
    ("report.view", "檢視報表"),
    ("automation.manage", "管理自動化規則"),
    ("sla.manage", "管理 SLA 政策"),
    ("proactive.manage", "管理主動式訊息"),
    ("settings.manage", "管理接待/系統設定"),
    ("webhook.manage", "管理對外 Webhook"),
    ("apikey.manage", "管理開放 API 金鑰"),
    # 轉售商(reseller):跨其名下租戶的計費/用量彙總視圖
    ("billing.reseller", "檢視轉售商跨租戶計費/用量儀表板"),
]

# ---------------------------------------------------------------------------
# 預設系統角色種子。除各開通路徑各自建立的 admin(全權,require() 以 "admin"
# 短路放行)外,補齊 agent(坐席)、supervisor(主管)、reseller(轉售商)三個
# 系統角色並綁合理權限子集,讓管理員邀人時有現成角色可指派,不必一律給 admin。
#
# 結構:(角色名, 說明, [權限碼子集])。權限碼須存在於 DEFAULT_PERMISSIONS,
# 綁定時以租戶內既有 Permission 對應;查無者略過(不擋種子)。
# 角色名在租戶內唯一(uq_role_tenant_name),故與 admin 不衝突。
# ---------------------------------------------------------------------------
# 坐席日常:會話收發/轉接/關閉、工單處理、知識庫與同事/技能組檢視(供轉接選人)。
_AGENT_PERMISSIONS: list[str] = [
    "conversation.view",
    "conversation.assign",
    "conversation.transfer",
    "conversation.close",
    "knowledge.view",
    "ticket.view",
    "ticket.manage",
    "staff.view",
    "skillgroup.view",
]
# 主管:坐席全部 + 報表、質檢(檢視+標註)、稽核、組織與技能組(路由)管理檢視。
_SUPERVISOR_PERMISSIONS: list[str] = _AGENT_PERMISSIONS + [
    "report.view",
    "quality.view",
    "quality.manage",
    "audit.view",
    "organization.view",
    "skillgroup.manage",
]
# 轉售商:跨租戶計費視圖(billing._require_reseller 以「reseller」角色名比對)+ 報表。
_RESELLER_PERMISSIONS: list[str] = [
    "billing.reseller",
    "report.view",
]

DEFAULT_ROLES: list[tuple[str, str, list[str]]] = [
    ("agent", "坐席(日常會話/工單/知識庫檢視與回覆)", _AGENT_PERMISSIONS),
    ("supervisor", "主管(坐席權限 + 報表/質檢/路由檢視)", _SUPERVISOR_PERMISSIONS),
    ("reseller", "轉售商(跨租戶計費/用量視圖)", _RESELLER_PERMISSIONS),
]

# 有效的坐席狀態值(presence)。
VALID_STAFF_STATUS = {"online", "busy", "away", "offline"}

# llm_config 內視為敏感、回傳時需遮罩的欄位。
_SECRET_LLM_KEYS = {"api_key", "apikey", "secret", "token", "access_key"}


async def seed_default_permissions(db: AsyncSession, tenant_id: uuid.UUID) -> int:
    """為指定租戶補齊預設權限碼(已存在的碼會略過)。回傳新建立的筆數。"""
    existing = set(
        (
            await db.execute(
                select(Permission.code).where(Permission.tenant_id == tenant_id)
            )
        ).scalars().all()
    )
    created = 0
    seen: set[str] = set()
    for code, desc in DEFAULT_PERMISSIONS:
        if code in existing or code in seen:  # 去重:既有 + 清單內重複皆略過
            continue
        seen.add(code)
        db.add(Permission(tenant_id=tenant_id, code=code, description=desc))
        created += 1
    await db.flush()
    # 權限碼備妥後,一併補齊預設系統角色(agent/supervisor/reseller)。
    # 三條開通路徑(register / provision / create_tenant)皆呼叫本函式,故角色
    # 種子在此集中處理,無須改動各路由。回傳值維持「新建立的權限碼筆數」。
    await seed_default_roles(db, tenant_id)
    return created


async def seed_default_roles(db: AsyncSession, tenant_id: uuid.UUID) -> int:
    """為指定租戶補齊預設系統角色(agent/supervisor/reseller)並綁權限子集。

    冪等:角色名已存在(不論是否軟刪,避開 uq_role_tenant_name 衝突)則略過,
    不重綁權限。不建立 admin(由各開通路徑自行建立,require() 亦對其短路放行)。
    回傳新建立的角色筆數。
    """
    existing_roles = set(
        (
            await db.execute(select(Role.name).where(Role.tenant_id == tenant_id))
        ).scalars().all()
    )
    # 權限碼 -> id 對照(含本租戶既有與剛種下的)。
    perm_map: dict[str, uuid.UUID] = {
        code: pid
        for pid, code in (
            await db.execute(
                select(Permission.id, Permission.code).where(
                    Permission.tenant_id == tenant_id
                )
            )
        ).all()
    }
    created = 0
    for name, desc, codes in DEFAULT_ROLES:
        if name in existing_roles:
            continue
        role = Role(tenant_id=tenant_id, name=name, description=desc, is_system=True)
        db.add(role)
        await db.flush()  # 取得 role.id
        for code in dict.fromkeys(codes):  # 去重、保序
            pid = perm_map.get(code)
            if pid is not None:
                await db.execute(
                    insert(role_permission).values(role_id=role.id, permission_id=pid)
                )
        created += 1
    await db.flush()
    return created


def _mask_secret(value: Any) -> Any:
    """把單一敏感字串遮罩成 `****abcd`(保留尾 4 碼以便辨識),非字串原樣回傳。"""
    if not isinstance(value, str) or value == "":
        return value
    tail = value[-4:] if len(value) >= 4 else ""
    return f"****{tail}"


def mask_llm_config(config: dict | None) -> dict | None:
    """回傳 llm_config 的遮罩副本;不改動資料庫內容。

    只遮罩已知敏感欄位(api_key 等),其餘(provider/base_url/model…)照常回傳,
    方便前端顯示目前設定。
    """
    if not config:
        return config
    masked: dict[str, Any] = {}
    for key, val in config.items():
        if key.lower() in _SECRET_LLM_KEYS:
            masked[key] = _mask_secret(val)
        else:
            masked[key] = val
    return masked


def paginate_params(page: int, size: int) -> tuple[int, int, int]:
    """把 page/size 正規化,回傳 (page, size, offset)。page 從 1 起算。"""
    page = max(page, 1)
    size = min(max(size, 1), 100)
    return page, size, (page - 1) * size


async def count_query(db: AsyncSession, stmt) -> int:
    """對一個 select 語句取總筆數(用於分頁 total)。"""
    subq = stmt.order_by(None).subquery()
    return int((await db.execute(select(func.count()).select_from(subq))).scalar_one())


async def bump_token_version(db: AsyncSession, staff: Staff) -> int:
    """原子遞增坐席的 token_version,使先前簽發的 access token 全數失效;回新版本。

    以 SQL 端 ``token_version + 1`` 遞增(非讀改寫):兩個同時進行的變更會得到不同版本,
    先完成者事後簽發的 token 也會被後完成者撤銷。flush 後重讀本欄,呼叫端可直接用
    ``staff.token_version`` 簽發新 token。僅 flush,不 commit(併入呼叫端交易)。
    """
    staff.token_version = Staff.token_version + 1
    await db.flush()
    await db.refresh(staff, attribute_names=["token_version"])
    return staff.token_version


async def mark_password_changed(db: AsyncSession, staff: Staff) -> int:
    """任何改密入口共用的收尾:刷新 password_changed_at 並撤銷既發 access token。

    - password_changed_at=now:先前簽發的密碼重設連結因 iat 早於此而失效(見 auth.reset_password)。
    - token_version + 1:改密前簽發的 access token(含 /ws/agent 連線)全數失效。
    呼叫端負責先寫好 password_hash、事後 commit;需要續用的 session 另行簽發新 token。
    """
    staff.password_changed_at = datetime.now(timezone.utc)
    return await bump_token_version(db, staff)
