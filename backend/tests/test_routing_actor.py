"""/claim 與 /sessions/{id}/assign/{target} 必須把操作者帶進 manual_assign 的 actor_staff_id,
session.assigned 事件的 actor 才會是操作者 staff id(契約 §4.2),而不是 None。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from app.api.v1 import routing as routing_api


class _Staff(SimpleNamespace):
    def require(self, *_perms: str) -> None:  # 權限檢查在此測試中一律放行
        return None


@pytest.fixture
def captured(monkeypatch):
    calls: list[dict] = []

    async def fake_manual_assign(db, tenant_id, session_id, staff_id, *, actor_staff_id=None):
        calls.append(
            {"tenant_id": tenant_id, "session_id": session_id, "staff_id": staff_id, "actor": actor_staff_id}
        )
        return staff_id

    monkeypatch.setattr(routing_api.routing_svc, "manual_assign", fake_manual_assign)
    return calls


@pytest.mark.asyncio
async def test_claim_passes_self_as_actor(captured):
    me = _Staff(tenant_id=uuid.uuid4(), staff_id=uuid.uuid4())
    sid = uuid.uuid4()
    await routing_api.claim(session_id=sid, staff=me, db=None)
    assert captured == [{"tenant_id": me.tenant_id, "session_id": sid, "staff_id": me.staff_id, "actor": me.staff_id}]


@pytest.mark.asyncio
async def test_assign_to_passes_operator_as_actor(captured):
    boss = _Staff(tenant_id=uuid.uuid4(), staff_id=uuid.uuid4())
    sid, target = uuid.uuid4(), uuid.uuid4()
    await routing_api.assign_to(session_id=sid, target_staff_id=target, staff=boss, db=None)
    assert captured == [{"tenant_id": boss.tenant_id, "session_id": sid, "staff_id": target, "actor": boss.staff_id}]
