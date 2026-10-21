"""新手 onboarding 首次使用清單 API:回報租戶「開始設定」各步驟完成度。

對齊 LiveChat Home 的 to-do 清單:新租戶登入後,依現有資料即時算出「下一步」該做什麼。
router 前綴由整合者掛載為 /api/v1/onboarding(見 app/main.py 的 include_router)。
所有查詢一律以 staff.tenant_id 過濾(租戶隔離),回覆走 app.core.response 信封。

效能:每個步驟只用「常數個聚合 count 查詢」判定,無 N+1;渠道三項(是否有渠道 / 是否有
web 渠道 / 是否有啟用渠道)以單一 CASE 聚合合併為一趟查詢,不逐列掃描。
"""
from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import case, func, or_, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.models.ai import AIAgentConfig
from app.models.conversation import Channel
from app.models.iam import Staff
from app.models.knowledge import Document, KnowledgeCollection

router = APIRouter()

# 步驟顯示順序(前端據此渲染)。key 為穩定識別碼,文案由前端 i18n 提供。
STEP_ORDER = ["channel", "widget", "knowledge", "ai", "staff", "channel_live"]


@router.get("/status")
async def onboarding_status(staff: CurrentStaff, db: DbSession):
    """回租戶 onboarding 各步驟完成度:{steps:[{key, done}], done_count, total}。

    步驟(皆以現有資料即時計算、租戶隔離):
      - channel      已建至少一個渠道(web/telegram/email…)
      - widget       已建 web 渠道(可嵌入網站的聊天小工具)
      - knowledge    已建至少一個知識庫集合(或已有文件)
      - ai           已設定 AI 代理(AIAgentConfig 存在)
      - staff        已建 ≥2 個坐席(admin 之外還有人)
      - channel_live 至少一個渠道 is_active(正式對外接收對話)

    全部完成時 done_count == total,前端據此隱藏「開始設定」卡。
    """
    tid = staff.tenant_id

    # 渠道三項合併為單一聚合:總數 / web 渠道數 / 啟用渠道數,避免三趟往返。
    ch_row = (
        await db.execute(
            select(
                func.count(),
                func.coalesce(func.sum(case((Channel.type == "web", 1), else_=0)), 0),
                func.coalesce(func.sum(case((Channel.is_active.is_(True), 1), else_=0)), 0),
            )
            .select_from(Channel)
            .where(Channel.tenant_id == tid, Channel.deleted_at.is_(None))
        )
    ).one()
    channel_total = int(ch_row[0] or 0)
    web_count = int(ch_row[1] or 0)
    active_count = int(ch_row[2] or 0)

    # 知識庫:集合或文件任一有資料即算完成(文件必掛集合,查集合通常已足夠,
    # 仍併查文件以完整涵蓋「或有文件」語意)。
    collection_count = (
        await db.execute(
            select(func.count())
            .select_from(KnowledgeCollection)
            .where(
                KnowledgeCollection.tenant_id == tid,
                KnowledgeCollection.deleted_at.is_(None),
            )
        )
    ).scalar_one()
    document_count = (
        await db.execute(
            select(func.count())
            .select_from(Document)
            .where(Document.tenant_id == tid, Document.deleted_at.is_(None))
        )
    ).scalar_one()

    # AI 代理設定是否存在(任一筆即算已設定)。
    ai_config_count = (
        await db.execute(
            select(func.count())
            .select_from(AIAgentConfig)
            .where(AIAgentConfig.tenant_id == tid, AIAgentConfig.deleted_at.is_(None))
        )
    ).scalar_one()

    # 坐席數(含 admin);≥2 代表 admin 之外還有其他「已生效」坐席。
    # 排除「未接受的 pending 邀請」(is_active=False 且 invite_accepted_at 為空):
    # 這類帳號尚未成為真正成員,不應讓 onboarding 提前顯示完成、之後又回退。
    staff_count = (
        await db.execute(
            select(func.count())
            .select_from(Staff)
            .where(
                Staff.tenant_id == tid,
                Staff.deleted_at.is_(None),
                or_(Staff.is_active.is_(True), Staff.invite_accepted_at.isnot(None)),
            )
        )
    ).scalar_one()

    done_map = {
        "channel": channel_total >= 1,
        "widget": web_count >= 1,
        "knowledge": (collection_count or 0) >= 1 or (document_count or 0) >= 1,
        "ai": (ai_config_count or 0) >= 1,
        "staff": (staff_count or 0) >= 2,
        "channel_live": active_count >= 1,
    }

    steps = [{"key": key, "done": bool(done_map[key])} for key in STEP_ORDER]
    done_count = sum(1 for step in steps if step["done"])
    return ok({"steps": steps, "done_count": done_count, "total": len(steps)})
