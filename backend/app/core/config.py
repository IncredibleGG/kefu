"""Application settings loaded from environment (.env)."""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="KEFU_", extra="ignore")

    # Core
    app_name: str = "kefu"
    environment: str = "dev"
    debug: bool = True
    # SQL echo 預設關閉:開啟會把每條 SQL 印進日誌(正式環境海量、且可能外露資料)。
    # 需除錯時設 KEFU_SQL_ECHO=true。
    sql_echo: bool = False

    # Security
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24
    # 靜態加密金鑰(用於加密資料庫內機敏欄位,如 bot_token/SMTP 密碼)。
    # 未設則由 jwt_secret 衍生(見 app.core.crypto),正式環境建議獨立設定。
    secret_key: str | None = None
    # CORS 允許來源:逗號分隔;"*" 全開(widget 跨網域嵌入需要)。正式可收緊為清單。
    cors_origins: str = "*"

    # Datastores
    database_url: str = "postgresql+asyncpg://kefu:kefu@localhost:5432/kefu"
    redis_url: str = "redis://localhost:6379/0"

    # LLM (dev default: OpenAI-compatible proxy; product supports per-tenant BYO-Key)
    openai_api_key: str | None = None
    # OpenAI 相容端點;自架代理以 KEFU_OPENAI_BASE_URL 覆寫(部署環境在 .env 設定)。
    openai_base_url: str = "https://api.openai.com/v1"
    default_llm_provider: str = "openai"
    default_llm_model: str = "gpt-5.5"  # 以 KEFU_DEFAULT_LLM_MODEL 覆寫成端點實際提供的模型

    # AI 工具呼叫(function calling)全域開關;預設關,啟用後 AI 可呼叫唯讀內建工具
    ai_tools_enabled: bool = False

    # Stripe 計費(測試模式):金鑰未設則計費收款功能停用(見 stripe_gateway)
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None

    # Embeddings: the proxy has NO embedding model, so default to a LOCAL model
    # (fastembed). Pluggable; a tenant may point this at an embedding API instead.
    embedding_provider: str = "local"  # local | openai
    # fastembed-supported multilingual model (incl. Chinese), 384-dim, light
    embedding_model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    embedding_dim: int = 384

    request_timeout_seconds: int = 60

    def is_production_like(self) -> bool:
        """環境是否為正式/類正式(prod / production / staging / release)。"""
        return self.environment.strip().lower() in {
            "prod",
            "production",
            "staging",
            "stage",
            "release",
        }

    def assert_secrets_safe(self) -> None:
        """正式環境 fail-closed:JWT 簽章金鑰不得為預設值 / 空值,否則拒絕啟動。

        預設 ``change-me-in-production`` 若被帶到正式環境,HS256 簽章金鑰即為公開值,
        任何人可偽造 admin / 跨租戶 / 平台超管 token。dev/test 不套用此檢查(便於本地)。
        於 app 啟動(lifespan)呼叫一次。
        """
        if not self.is_production_like():
            return
        weak = {"", "change-me-in-production", "change-me", "changeme", "secret", "dev"}
        if (self.jwt_secret or "").strip() in weak:
            raise RuntimeError(
                "KEFU_JWT_SECRET 為預設 / 弱值,正式環境拒絕啟動;請設定一組高熵隨機值。"
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
