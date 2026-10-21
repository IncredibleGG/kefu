# 資料庫遷移(Alembic)

本專案以 **Alembic** 管理資料庫 schema 版本,取代早期「`create_all` + 手動
`ALTER`」的做法。自基線起,**所有** schema 變更都走 Alembic,不要再手動改表。

## 檔案結構

```
backend/
├── alembic.ini                       # Alembic 設定(script_location、logging)
├── alembic/
│   ├── env.py                        # 環境:掛 metadata、取 DB URL、async 執行
│   ├── script.py.mako                # 新遷移檔的模板(autogenerate 用)
│   └── versions/
│       └── 0001_baseline.py          # 基線:大爆炸一次建出全部表
└── MIGRATIONS.md                     # 本文件
```

- **`env.py`**
  - `target_metadata = app.core.db.Base.metadata`;並 `import app.models` 讓
    **全部 ORM 表**都註冊進 metadata(autogenerate 才看得到所有表)。
  - 資料庫 URL **一律取自** `app.core.config.settings.database_url`(容器內由環境
    變數 `KEFU_DATABASE_URL` 提供),覆寫 `alembic.ini` 內的佔位值——**單一事實
    來源**,遷移與 App 永遠連同一個 DB。
  - App 的 engine 是 async(`postgresql+asyncpg://`)。env.py 用 **async engine +
    `connection.run_sync(...)`** 跑同步的遷移流程,因此**不需要**額外安裝 sync
    driver(psycopg)。離線 `--sql` 模式則把 `+asyncpg` 去掉,只用 URL 判斷方言。
  - 匯入 `pgvector.sqlalchemy`,讓 autogenerate 能辨識 `Vector` 欄位型別。
  - `compare_type=True`:欄位型別變更也納入 autogenerate 偵測。

- **`0001_baseline.py`(基線,採「大爆炸」策略)**
  - `upgrade()`:先 `CREATE EXTENSION IF NOT EXISTS vector`,再
    `Base.metadata.create_all(...)` 依 metadata **一次建出目前全部表**(現為 37 張,
    涵蓋所有既有模型)。不逐張手列——新增模型後,基線在全新 DB 上自然涵蓋。
  - `downgrade()`:`Base.metadata.drop_all(...)` 卸下所有表(extension 保留不刪)。

> App 端的 `app/core/db.py::init_db()`(`create_all`)**保留不動**,僅作為本機
> 開發/測試的 fallback,不參與正式遷移流程。

---

## 情境一:全新環境(空 DB)

直接升到最新版即可建整個 schema:

```bash
docker compose exec backend alembic upgrade head
```

基線會建好 pgvector extension 與全部表。

> 健全性檢查(選用):建完後跑一次 autogenerate 應顯示「無變更」,代表 metadata
> 與實際 schema 一致:
> ```bash
> docker compose exec backend alembic revision --autogenerate -m "sanity check"
> # 檢視產生的檔案:upgrade()/downgrade() 應為空(pass)。確認後刪掉該檔即可。
> ```

---

## 情境二:既有已部署 DB(例:已在跑的 demo 主機那套)

該 DB 先前已用 `init_db`/`create_all` 建好整個 schema,表都已存在。**不要**跑
`upgrade`(會嘗試重複建表),而是把版本**對齊**到基線,標記為「已在最新版」:

```bash
docker compose exec backend alembic stamp head
```

`stamp` 只寫入 `alembic_version` 版本記錄、**不執行任何 DDL**。之後這台就與全新
環境走同一套流程。

> 對齊後可用 `docker compose exec backend alembic current` 確認顯示 `0001_baseline (head)`。

---

## 日後修改 schema 的標準流程(所有環境一致)

1. 改 `backend/app/models/` 底下的 ORM 模型(新增表/欄位/索引…)。
2. 產生遷移(autogenerate 會比對模型與現有 DB 的差異):
   ```bash
   docker compose exec backend alembic revision --autogenerate -m "描述本次變更"
   ```
3. **檢查**產生於 `alembic/versions/` 的遷移檔:確認 `upgrade()`/`downgrade()`
   內容正確(autogenerate 對索引改名、型別細節、pgvector 等偶有誤判,需人工校對)。
4. 套用:
   ```bash
   docker compose exec backend alembic upgrade head
   ```
5. 把新遷移檔一起提交進版本庫。

> **一律經由 Alembic,不要再手動 `ALTER TABLE`**;手動改表會讓 DB 與遷移歷史脫節,
> 之後 autogenerate 會產生錯誤的差異。

---

## 常用指令速查(皆在容器內執行)

```bash
docker compose exec backend alembic current            # 目前版本
docker compose exec backend alembic history            # 遷移歷史
docker compose exec backend alembic heads              # 目前 head(s)
docker compose exec backend alembic upgrade head       # 升到最新
docker compose exec backend alembic downgrade -1       # 回退一版
docker compose exec backend alembic upgrade head --sql # 只輸出 SQL(離線、不連 DB)
```

## 說明

- 上述指令的服務名 `backend` 對應 `docker-compose.yml` 的 backend service;該容器
  WORKDIR 為 `/app`,`alembic.ini` 與 `alembic/` 已隨映像複製到 `/app` 下,故容器內
  直接 `alembic ...` 即可(會自動讀 `/app/alembic.ini`)。
- 在本機(非容器)執行時,需先安裝 alembic(已列於 `pyproject.toml` 主依賴),並在
  `backend/` 目錄下執行 `alembic ...`;DB URL 一樣由 `KEFU_DATABASE_URL` 或
  `settings` 決定。
