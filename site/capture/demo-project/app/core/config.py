from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ACME_", env_file=".env")

    version: str = "1.4.0"
    database_url: str = "sqlite:///./acme.db"
    smtp_host: str = "localhost"
    smtp_timeout_s: float = 10.0
    email_from: str = "Acme <hello@acme.dev>"
    password_hash_rounds: int = 12


settings = Settings()
