"""網站爬取:抓取頁面(遵守 robots.txt、限頁數/深度)、用 BeautifulSoup 抽正文。

僅用既有 httpx(非同步)+ 標準庫 urllib(robots 規則解析),不引入瀏覽器相依。
設計為「盡量降級」:單頁抓取/解析失敗只跳過該頁,不中斷整體爬取。
只在同一網域(netloc)內做 BFS,並以 max_pages / max_depth 上限避免爆量。

bs4 採函式內延遲匯入:未安裝時該次爬取失敗降級(由 worker 記為 failed),
不影響 app 其餘部分啟動。
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from urllib.parse import urldefrag, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx

from app.services.ingest.net_guard import BlockedURLError, assert_url_public_async

logger = logging.getLogger("kefu.ingest.crawler")

DEFAULT_USER_AGENT = "kefu-knowledge-crawler/1.0 (+https://kefu.local/bot)"

# 單頁下載大小上限(可由環境變數覆寫);串流累計超過即中止,不整包 resp.text 惡意大檔。
_DEFAULT_CRAWL_MAX_BYTES = 2 * 1024 * 1024
# 手動逐跳跟進轉址的最大次數(關閉 httpx 自動轉址,改為每跳先驗證主機非私網)。
_MAX_REDIRECTS = 5


def _crawl_max_bytes() -> int:
    raw = os.environ.get("KEFU_CRAWL_MAX_BYTES")
    if raw and raw.isdigit():
        return int(raw)
    return _DEFAULT_CRAWL_MAX_BYTES


class _ResponseTooLarge(Exception):
    """單頁回應超過大小上限(串流累計時中止)。"""


class _TooManyRedirects(Exception):
    """轉址跳數超過上限。"""

# 只抓 HTML;其他 content-type(pdf/圖片/檔案)略過
_HTML_CT_HINTS = ("text/html", "application/xhtml")
# 明顯非文章的連結副檔名,不進佇列
_SKIP_EXTS = (
    ".pdf", ".zip", ".rar", ".7z", ".gz", ".tar",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
    ".mp4", ".mp3", ".avi", ".mov", ".wav",
    ".css", ".js", ".json", ".xml", ".rss",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
)
# 抽正文前移除的非內文節點
_STRIP_TAGS = (
    "script", "style", "noscript", "template", "svg",
    "nav", "footer", "header", "aside", "form",
)


@dataclass
class CrawledPage:
    url: str
    title: str | None
    text: str


@dataclass
class CrawlResult:
    pages: list[CrawledPage] = field(default_factory=list)
    fetched: int = 0
    skipped_robots: int = 0
    errors: int = 0


def _normalize(url: str) -> str:
    """去掉錨點(#...),便於去重。"""
    return urldefrag(url)[0]


def _same_site(a: str, b: str) -> bool:
    return urlparse(a).netloc.lower() == urlparse(b).netloc.lower()


def _looks_like_asset(url: str) -> bool:
    return urlparse(url).path.lower().endswith(_SKIP_EXTS)


def extract_text_and_links(html: str, base_url: str) -> tuple[str | None, str, list[str]]:
    """從 HTML 抽 (title, 正文純文字, 同頁所有連結的絕對網址)。

    連結先從完整文件收集(避免被下方移除的 nav/footer 影響到連結發現),
    再移除非內文節點後抽正文。優先取 <main>/<article>,否則退回 <body>。
    """
    from bs4 import BeautifulSoup  # 延遲匯入:相依未裝時由上層降級處理

    soup = BeautifulSoup(html, "html.parser")

    # 先收集連結(此時尚未移除任何節點)
    links: list[str] = []
    for a in soup.find_all("a", href=True):
        href = _normalize(urljoin(base_url, a["href"].strip()))
        if href.startswith(("http://", "https://")):
            links.append(href)

    title = None
    if soup.title and soup.title.string:
        title = soup.title.string.strip()

    for tag in soup(list(_STRIP_TAGS)):
        tag.decompose()

    root = soup.find("main") or soup.find("article") or soup.body or soup
    text = root.get_text(separator="\n", strip=True)
    return title, text, links


async def _guarded_fetch(
    client: httpx.AsyncClient,
    url: str,
    *,
    max_bytes: int,
    html_only: bool,
) -> tuple[int, str, str, str | None]:
    """關閉自動轉址、逐跳做 SSRF 驗證並串流限制大小地抓取 url。

    回 ``(status_code, final_url, content_type, text)``:
      - ``text is None`` 表示未取內文(status>=400,或 ``html_only`` 且回應非 HTML)。
      - 其餘情況 ``text`` 為(已依大小上限截斷前中止的)解碼後純文字,可能為空字串。

    每一跳(含每次 redirect 後的新目標)都先 ``assert_url_public_async`` 驗證主機解析
    出的 IP 為公網;不合法即拋 ``BlockedURLError``。超過大小上限拋 ``_ResponseTooLarge``,
    轉址過多拋 ``_TooManyRedirects``。呼叫端負責攔截並降級,不讓例外冒成未捕捉。
    """
    current = _normalize(url)
    for _hop in range(_MAX_REDIRECTS + 1):
        # 逐跳:發請求前先驗證目標主機非私網/內網(拋 BlockedURLError)。
        await assert_url_public_async(current)
        async with client.stream("GET", current) as resp:
            if resp.is_redirect:
                loc = resp.headers.get("location")
                if loc:
                    current = _normalize(urljoin(current, loc))
                    continue
                # 無 Location 的 3xx:當一般回應處理(往下走)。
            status = resp.status_code
            ct = resp.headers.get("content-type", "").lower()
            final_url = str(resp.url)
            if status >= 400:
                return status, final_url, ct, None
            if html_only and ct and not any(h in ct for h in _HTML_CT_HINTS):
                # 非 HTML(檔案/圖片):不下載大 body,回 text=None 供呼叫端略過。
                return status, final_url, ct, None
            body = bytearray()
            async for chunk in resp.aiter_bytes():
                if not chunk:
                    continue
                body += chunk
                if len(body) > max_bytes:
                    raise _ResponseTooLarge()
            try:
                text = bytes(body).decode(resp.charset_encoding or "utf-8", errors="replace")
            except (LookupError, TypeError):  # 未知/畸形 charset
                text = bytes(body).decode("utf-8", errors="replace")
            return status, final_url, ct, text
    raise _TooManyRedirects()


async def _load_robots(
    client: httpx.AsyncClient, start_url: str, user_agent: str
) -> RobotFileParser | None:
    """讀取起始網域的 robots.txt;讀不到(4xx/例外/被 SSRF 防護拒絕)視為不設限(回 None)。"""
    robots_url = urljoin(start_url, "/robots.txt")
    try:
        status, _final, _ct, text = await _guarded_fetch(
            client, robots_url, max_bytes=_crawl_max_bytes(), html_only=False
        )
    except Exception:  # noqa: BLE001 - robots 讀取失敗(含 BlockedURLError)即降級為不設限
        logger.debug("讀取 robots.txt 失敗(視為不設限):%s", robots_url)
        return None
    if status >= 400 or text is None:
        return None
    rp = RobotFileParser()
    rp.parse(text.splitlines())
    return rp


async def crawl_site(
    start_url: str,
    *,
    max_pages: int = 20,
    max_depth: int = 2,
    user_agent: str = DEFAULT_USER_AGENT,
    timeout: float = 20.0,
) -> CrawlResult:
    """從 start_url 起同網域 BFS 爬取,回抓到的頁面(含 title / 正文)。

    - 遵守 robots.txt(不允許的 URL 略過並計入 skipped_robots)。
    - 只抓 HTML、只走同網域、跳過明顯資產連結;達 max_pages 即停。
    - 每頁獨立 try/except:單頁失敗只計入 errors,不中斷整體。
    """
    start_url = _normalize((start_url or "").strip())
    parsed = urlparse(start_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("無效的起始網址(需 http/https 絕對網址)")
    # 起手即擋 SSRF:起始網址若指向私網/內網,直接拒絕並回明確錯誤(worker 記為 failed)。
    try:
        await assert_url_public_async(start_url)
    except BlockedURLError as e:
        raise ValueError(f"拒絕爬取私網/內網起始網址:{e}") from e

    max_pages = max(1, int(max_pages))
    max_depth = max(0, int(max_depth))
    max_bytes = _crawl_max_bytes()
    # 抓取嘗試上限:避免頁面內容稀疏時無限擴張佇列
    fetch_cap = max_pages * 5

    result = CrawlResult()
    headers = {"User-Agent": user_agent}
    # 關閉自動轉址:改由 _guarded_fetch 手動逐跳跟進,並在每跳前驗證主機非私網,
    # 避免站點以 3xx 轉址到內網 / 雲端 metadata 繞過 SSRF 防護。
    async with httpx.AsyncClient(
        headers=headers,
        timeout=timeout,
        follow_redirects=False,
        limits=httpx.Limits(max_connections=4),
    ) as client:
        robots = await _load_robots(client, start_url, user_agent)

        visited: set[str] = set()
        queue: list[tuple[str, int]] = [(start_url, 0)]
        while queue and len(result.pages) < max_pages and result.fetched < fetch_cap:
            url, depth = queue.pop(0)
            if url in visited:
                continue
            visited.add(url)

            if robots is not None and not robots.can_fetch(user_agent, url):
                result.skipped_robots += 1
                continue

            try:
                status, final_url, _ct, text = await _guarded_fetch(
                    client, url, max_bytes=max_bytes, html_only=True
                )
            except BlockedURLError:
                # 被 SSRF 防護擋下(私網/內網/非法 scheme,含轉址目標):計 error,不中斷。
                result.errors += 1
                logger.info("SSRF 防護拒絕爬取目標:%s", url)
                continue
            except _ResponseTooLarge:
                result.errors += 1
                logger.info("頁面超過大小上限(>%d bytes),略過:%s", max_bytes, url)
                continue
            except _TooManyRedirects:
                result.errors += 1
                logger.info("轉址次數過多,略過:%s", url)
                continue
            except Exception:  # noqa: BLE001 - 單頁抓取失敗只計 error,不中斷整體
                result.errors += 1
                continue

            if status >= 400:
                result.errors += 1
                continue
            if text is None:
                continue  # 非 HTML(檔案/圖片)略過,不計 error

            result.fetched += 1
            try:
                title, page_text, links = extract_text_and_links(text, final_url)
            except Exception:  # noqa: BLE001 - 單頁抽正文失敗只計 error,不中斷整體
                result.errors += 1
                logger.debug("抽正文失敗:%s", url)
                continue

            if page_text and page_text.strip():
                result.pages.append(CrawledPage(url=final_url, title=title, text=page_text))

            if depth < max_depth:
                for link in links:
                    if (
                        link not in visited
                        and _same_site(start_url, link)
                        and not _looks_like_asset(link)
                    ):
                        queue.append((link, depth + 1))

    return result
