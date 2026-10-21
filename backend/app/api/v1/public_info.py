"""公開伺服器資訊(免登入):供原生 App「設定伺服器」時確認對方真的是 kefu,並決定功能顯示。

前綴 ``/api/v1/public``(與 branding.public_router 共用前綴,路徑不重疊)。

``GET /server-info`` 回:
``{app:"kefu", api_version:1, server_version, min_app_version:"0.1.0",
  features:{google_sso, saml, push}}``

- 只回布林旗標與版本號,不洩漏任何設定值(client_id、金鑰、環境名稱等一律不回)。
- ``push`` 以防禦式匯入 ``app.services.push``:模組尚未存在或 ``is_configured()`` 出錯皆回 False。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter

from app.core.response import ok

logger = logging.getLogger("kefu.public_info")

router = APIRouter()

APP_NAME = "kefu"
API_VERSION = 1
# 原生 App 最低支援版本:低於此版本的 App 應提示強制更新(契約 docs/NATIVE-CLIENTS.md §4.1)
MIN_APP_VERSION = "0.1.0"
# 無法從套件 metadata 取得版本時的後備值(對齊 pyproject.toml / FastAPI app version)
_FALLBACK_SERVER_VERSION = "0.1.0"


def server_version() -> str:
    """後端版本:優先讀已安裝套件 metadata(kefu-backend),否則回後備常數。"""
    try:
        from importlib.metadata import version

        return version("kefu-backend")
    except Exception:  # noqa: BLE001 — 未以套件安裝(如原始碼直跑 / 測試)
        return _FALLBACK_SERVER_VERSION


def _google_sso_enabled() -> bool:
    try:
        from app.api.v1.auth import google_sso_configured

        return bool(google_sso_configured())
    except Exception:  # noqa: BLE001
        return False


def _saml_enabled() -> bool:
    """SAML 是否「可用」:取決於部署是否具備完整 XML-DSig 驗簽能力(signxml)。

    未安裝時 ACS 一律 fail-closed 拒絕,App 不應顯示 SAML 按鈕。是否對某租戶啟用另由
    ``/api/v1/saml/login/{slug}`` 的 SSO_DISABLED 回應判斷。
    """
    try:
        from app.api.v1 import saml

        return bool(getattr(saml, "_SIGNXML_AVAILABLE", False))
    except Exception:  # noqa: BLE001
        return False


def _push_enabled() -> bool:
    """推播是否已設定(FCM);app.services.push 不存在或出錯時回 False。"""
    try:
        from app.services import push  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 — 模組尚未加入
        return False
    try:
        return bool(push.is_configured())
    except Exception:  # noqa: BLE001
        logger.warning("push.is_configured() 失敗,視為未設定", exc_info=True)
        return False


@router.get("/server-info")
async def server_info():
    """免登入的伺服器資訊(App 探測伺服器 / 決定 SSO 按鈕 / 強制更新判斷)。"""
    return ok(
        {
            "app": APP_NAME,
            "api_version": API_VERSION,
            "server_version": server_version(),
            "min_app_version": MIN_APP_VERSION,
            "features": {
                "google_sso": _google_sso_enabled(),
                "saml": _saml_enabled(),
                "push": _push_enabled(),
            },
        }
    )
