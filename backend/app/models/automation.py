"""自動化規則引擎:AutomationRule(條件→動作)。

一條規則綁定某個「觸發事件」(trigger_event),命中時逐條比對 conditions
(全部成立才算命中,AND 語義),再依序執行 actions。conditions / actions 皆以
JSONB 存放,結構由前端規則建構器組出、後端(services.automation)解讀。

注意:本模型未登記進 app/models/__init__.py(不得改該檔)。只要 automation 的
服務或路由被匯入,SQLAlchemy 即會把此 mapper 註冊到 Base.metadata;正式建表
請由整合方於 app/models/__init__.py 補一行匯入(見交付報告)。所有查詢一律以
tenant_id 過濾。
"""
from __future__ import annotations

from sqlalchemy import Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# --- 合法值(供服務層引擎與 API 驗證共用)------------------------------------

# 可觸發規則的事件;埋點見 services/conversation.py 與 api/v1/conversation.py。
TRIGGER_EVENTS = (
    "message.visitor",   # 訪客傳來一則訊息
    "session.created",   # 新會話建立
    "session.closed",    # 會話結束
    "session.transfer",  # 會話轉接完成
)

# 條件比較運算子。
CONDITION_OPS = ("eq", "ne", "contains", "gt", "lt", "in")

# 動作型別;實作見 services/automation.py。
ACTION_TYPES = (
    "add_tag",             # 對會話加標籤(Tag / TagRelation)
    "assign_skill_group",  # 指派技能組
    "assign_staff",        # 指派坐席
    "set_status",          # 設定會話狀態
    "notify_agents",       # 對坐席工作台發即時通知
    "auto_reply",          # 對訪客自動回覆一段文字 / 罐頭內容
)

# 未指定時的預設優先序(數字越小越先執行)。
DEFAULT_PRIORITY = 100


class AutomationRule(Base, TenantScopedMixin):
    """一條自動化規則:trigger_event + conditions(AND)→ actions。"""

    __tablename__ = "automation_rule"

    # 規則名稱(顯示用)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 觸發事件(值 ∈ TRIGGER_EVENTS);常用查詢欄位,建索引
    trigger_event: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    # 條件清單:list of {field, op, value};空清單表示無條件(必命中)
    conditions: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # 動作清單:list of {type, params}
    actions: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # 是否啟用;停用者不參與比對
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False, index=True)
    # 執行優先序:數字越小越先執行(同值以 created_at 先後穩定排序)
    priority: Mapped[int] = mapped_column(Integer, default=DEFAULT_PRIORITY, nullable=False)
