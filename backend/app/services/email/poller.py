"""Email 收信輪詢器:對所有啟用的 email 渠道抓未讀新信,走標準入站流程。

``poll_email(db)`` 設計為「可被排程器定時呼叫」的無狀態函式(整合者在 main.py
lifespan 起一個 loop 週期呼叫)。每個渠道、每封信都獨立 try/except:
- IMAP 抓信失敗 → 記 log、該渠道略過,不影響其他渠道。
- 單封解析/入站失敗 → 記 log、計入 errors,不影響其他信。

入站沿用 ``channel_out.ingest_inbound``(其內部以 ``_resolve_seam`` 取
visitor / conversation / dispatch seam 並優雅降級),故本模組不重複造輪子:
以寄件人 email 當 external_id、寄件人名當 display_name、主旨+內文當訊息內容。

已讀標記策略:只有成功入站(拿到 session_id)或「無法解析/無寄件人」的信才標記
已讀。暫時降級(seam 未就緒,session_id 為 None)的信「不」標記,下輪自動重試。
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Channel
from app.services import channel_out
from app.services.email import imap_client, parser
from app.services.telegram import NormalizedInbound

logger = logging.getLogger("kefu.email.poller")

# 單一渠道單輪最多處理的未讀信數(避免積壓時一次吃爆)
_MAX_PER_POLL = 50


async def poll_email(db: AsyncSession) -> dict[str, Any]:
    """對所有 type='email' 且啟用的渠道抓未讀信並入站。回傳統計摘要。

    回傳:``{"channels": n, "fetched": n, "ingested": n, "errors": n}``
    """
    summary = {"channels": 0, "fetched": 0, "ingested": 0, "errors": 0}

    channels = (
        await db.execute(
            select(Channel).where(
                Channel.type == channel_out.CHANNEL_EMAIL,
                Channel.is_active.is_(True),
                Channel.deleted_at.is_(None),
            )
        )
    ).scalars().all()

    for channel in channels:
        imap_cfg = (channel.config or {}).get("imap") or {}
        if not imap_cfg.get("host"):
            continue  # 尚未設定 IMAP 的 email 渠道略過
        summary["channels"] += 1

        try:
            raws = await imap_client.fetch_unseen(imap_cfg, limit=_MAX_PER_POLL)
        except Exception:
            logger.exception("IMAP 抓信失敗(channel=%s)", channel.id)
            summary["errors"] += 1
            continue

        seen_uids: list[str] = []
        for raw in raws:
            summary["fetched"] += 1
            try:
                parsed = parser.parse_email(raw.raw)
            except Exception:
                logger.exception("郵件解析失敗(channel=%s uid=%s)", channel.id, raw.uid)
                summary["errors"] += 1
                seen_uids.append(raw.uid)  # 無法解析 → 標記已讀避免卡住
                continue

            if not parsed.from_email:
                logger.warning("郵件缺寄件人(channel=%s uid=%s),略過", channel.id, raw.uid)
                summary["errors"] += 1
                seen_uids.append(raw.uid)
                continue

            if parsed.subject and parsed.body:
                text = f"{parsed.subject}\n\n{parsed.body}"
            else:
                text = parsed.subject or parsed.body
            text = text.strip() or "(空白郵件)"

            inbound = NormalizedInbound(
                external_id=parsed.from_email,
                text=text,
                content_type="text",
                display_name=parsed.from_name or parsed.from_email,
                meta={
                    "provider": "email",
                    "subject": parsed.subject,
                    "message_id": parsed.message_id,
                    "from_email": parsed.from_email,
                },
            )

            try:
                session_id = await channel_out.ingest_inbound(
                    db, channel.tenant_id, channel.id, inbound
                )
            except Exception:
                logger.exception("email 入站失敗(channel=%s uid=%s)", channel.id, raw.uid)
                session_id = None

            if session_id is not None:
                summary["ingested"] += 1
                seen_uids.append(raw.uid)
            else:
                # 核心 seam 未就緒等暫時降級:不標記已讀,下輪重試
                summary["errors"] += 1

        if seen_uids:
            try:
                await imap_client.mark_seen(imap_cfg, seen_uids)
            except Exception:
                logger.exception("IMAP 標記已讀失敗(channel=%s)", channel.id)

    return summary
