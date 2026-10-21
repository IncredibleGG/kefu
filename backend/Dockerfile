FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir uv
# 依賴一律照 uv.lock 安裝:線上版本與 CI 測過的版本完全一致
# (舊做法 `uv pip install .` 每次重新解析,線上會跑到未經測試的新版本)
COPY pyproject.toml uv.lock ./
RUN uv export --frozen --no-dev --no-emit-project --format requirements-txt -o /tmp/requirements.txt \
 && uv pip install --system --no-cache -r /tmp/requirements.txt
COPY . .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
