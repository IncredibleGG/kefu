/**
 * 對外公開自助中心(Help Center) —— 無需登入。
 *
 * 路由:`/help/:slug`(slug = 租戶 slug,demo 可用 `/help/demo`)。
 * 版面:頂部品牌 + 搜尋框;左側分類(collections);右側內容(文章清單 → 單篇文章 / 搜尋結果);底部 FAQ。
 * 資料:一律走 `helpcenterPublic.ts`(自帶 fetch、同源相對路徑),只讀已發布內容。
 * 狀態同步到網址查詢字串(c=分類、article=文章、q=搜尋),故可分享 / 支援瀏覽器上一頁。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Search,
  ArrowLeft,
  BookOpen,
  HelpCircle,
  FileText,
  Loader2,
  Inbox,
  ExternalLink,
  LifeBuoy,
  ChevronRight,
} from "lucide-react";
import { renderMarkdown } from "@/lib/markdown";
import {
  fetchCollections,
  fetchArticles,
  fetchArticle,
  fetchFaqs,
  searchHelp,
  HelpCenterError,
} from "@/api/helpcenterPublic";
import type {
  HelpCollection,
  HelpArticleListItem,
  HelpArticle,
  HelpFaq,
  HelpSearchResult,
} from "@/api/helpcenterPublic";

const PAGE_SIZE = 20;

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("zh-Hant", { year: "numeric", month: "long", day: "numeric" });
}

/** 小型載入指示 */
function Spinner({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label ?? t("modules.help.loading")}
    </div>
  );
}

/** 空狀態 */
function EmptyState({ icon: Icon, text }: { icon: typeof Inbox; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
      <Icon className="h-10 w-10 opacity-40" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

export function PublicHelpCenter() {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();

  const activeCollection = params.get("c") ?? "";
  const activeArticleId = params.get("article") ?? "";
  const query = (params.get("q") ?? "").trim();

  // ------- 分類 / FAQ(隨 slug 載入一次) -------
  const [collections, setCollections] = useState<HelpCollection[]>([]);
  const [colState, setColState] = useState<"loading" | "ready" | "error">("loading");
  const [notFound, setNotFound] = useState(false);
  const [faqs, setFaqs] = useState<HelpFaq[]>([]);

  useEffect(() => {
    if (!slug) return;
    const ac = new AbortController();
    setColState("loading");
    setNotFound(false);
    fetchCollections(slug, ac.signal)
      .then((res) => {
        setCollections(res.collections);
        setColState("ready");
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        if (e instanceof HelpCenterError && e.code === "not_found") setNotFound(true);
        setColState("error");
      });
    fetchFaqs(slug, { size: 50 }, ac.signal)
      .then((res) => setFaqs(res.items))
      .catch(() => {
        /* FAQ 失敗不阻斷主流程 */
      });
    return () => ac.abort();
  }, [slug]);

  // ------- 文章清單(依分類,支援分頁載入更多) -------
  const [articles, setArticles] = useState<HelpArticleListItem[]>([]);
  const [artState, setArtState] = useState<"loading" | "ready" | "error">("loading");
  const [artPage, setArtPage] = useState(1);
  const [artTotal, setArtTotal] = useState(0);

  const inDetail = activeArticleId !== "";
  const inSearch = query !== "";
  const showList = !inDetail && !inSearch;

  useEffect(() => {
    // 只有在「清單模式」才載入(單篇 / 搜尋模式不需要)
    if (!slug || !showList) return;
    const ac = new AbortController();
    setArtState("loading");
    fetchArticles(slug, { collection: activeCollection || undefined, page: 1, size: PAGE_SIZE }, ac.signal)
      .then((res) => {
        setArticles(res.items);
        setArtTotal(res.total);
        setArtPage(1);
        setArtState("ready");
      })
      .catch(() => {
        if (!ac.signal.aborted) setArtState("error");
      });
    return () => ac.abort();
  }, [slug, activeCollection, showList]);

  const loadMore = useCallback(() => {
    const next = artPage + 1;
    const ac = new AbortController();
    fetchArticles(slug, { collection: activeCollection || undefined, page: next, size: PAGE_SIZE }, ac.signal)
      .then((res) => {
        setArticles((prev) => [...prev, ...res.items]);
        setArtPage(next);
        setArtTotal(res.total);
      })
      .catch(() => {
        /* 忽略載入更多失敗 */
      });
  }, [slug, activeCollection, artPage]);

  // ------- 單篇文章 -------
  const [article, setArticle] = useState<HelpArticle | null>(null);
  const [articleState, setArticleState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!slug || !inDetail) return;
    const ac = new AbortController();
    setArticleState("loading");
    setArticle(null);
    fetchArticle(slug, activeArticleId, ac.signal)
      .then((res) => {
        setArticle(res);
        setArticleState("ready");
      })
      .catch(() => {
        if (!ac.signal.aborted) setArticleState("error");
      });
    return () => ac.abort();
  }, [slug, activeArticleId, inDetail]);

  // ------- 搜尋(輸入即時 + 300ms 去抖,寫回網址 q) -------
  const [input, setInput] = useState(query);
  useEffect(() => {
    // 網址 q 由外部(上一頁 / 分享連結)改變時,同步輸入框
    setInput(query);
  }, [query]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitQuery = useCallback(
    (value: string) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          const v = value.trim();
          if (v) p.set("q", v);
          else p.delete("q");
          p.delete("article"); // 搜尋時退出單篇
          return p;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const onInputChange = (v: string) => {
    setInput(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commitQuery(v), 300);
  };

  const [searchResult, setSearchResult] = useState<HelpSearchResult | null>(null);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!slug || !inSearch) {
      setSearchResult(null);
      setSearchState("idle");
      return;
    }
    const ac = new AbortController();
    setSearchState("loading");
    searchHelp(slug, query, ac.signal)
      .then((res) => {
        setSearchResult(res);
        setSearchState("ready");
      })
      .catch(() => {
        if (!ac.signal.aborted) setSearchState("error");
      });
    return () => ac.abort();
  }, [slug, query, inSearch]);

  // ------- 導覽輔助:更新查詢字串 -------
  const setCollection = useCallback(
    (colSlug: string) => {
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        if (colSlug) p.set("c", colSlug);
        else p.delete("c");
        p.delete("article");
        p.delete("q");
        return p;
      });
    },
    [setParams],
  );

  const openArticle = useCallback(
    (id: string) => {
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        p.set("article", id);
        return p;
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [setParams],
  );

  const backToList = useCallback(() => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.delete("article");
      return p;
    });
  }, [setParams]);

  const collectionName = useMemo(() => {
    if (!activeCollection) return t("modules.help.allArticles");
    return collections.find((c) => c.slug === activeCollection || c.id === activeCollection)?.name ?? t("modules.help.article");
  }, [activeCollection, collections, t]);

  // ------- 租戶不存在 -------
  if (notFound) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <LifeBuoy className="h-12 w-12 text-brand" />
        <h1 className="text-xl font-semibold text-foreground">{t("modules.help.notFoundTitle")}</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {t("modules.help.notFoundPrefix")} <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{slug}</code> {t("modules.help.notFoundSuffix")}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* 頂部:品牌 + 搜尋 */}
      <header className="border-b border-border bg-gradient-to-b from-brand/10 to-background">
        <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
          <div className="mb-6 flex items-center gap-2 text-brand">
            <LifeBuoy className="h-6 w-6" />
            <span className="text-sm font-semibold tracking-wide">{t("modules.help.helpCenter")}</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground sm:text-3xl">{t("modules.help.heroTitle")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("modules.help.heroSubtitle")}</p>
          <form
            className="mt-6 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (debounceRef.current) clearTimeout(debounceRef.current);
              commitQuery(input);
            }}
          >
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                placeholder={t("modules.help.searchPlaceholder")}
                aria-label={t("modules.help.searchAriaLabel")}
                className="w-full rounded-xl border border-input bg-card py-3 pl-11 pr-4 text-sm shadow-sm outline-none ring-brand/40 transition focus:border-brand focus:ring-2"
              />
            </div>
            <button
              type="submit"
              className="shrink-0 rounded-xl bg-brand px-5 py-3 text-sm font-semibold text-brand-foreground shadow-sm transition hover:opacity-90"
            >
              {t("modules.help.search")}
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[220px_1fr]">
        {/* 左側:分類 */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <BookOpen className="h-4 w-4" /> {t("modules.help.categories")}
          </h2>
          {colState === "loading" ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-9 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : (
            <nav className="flex flex-col gap-1">
              <button
                onClick={() => setCollection("")}
                className={`rounded-lg px-3 py-2 text-left text-sm transition ${
                  !activeCollection && !inSearch
                    ? "bg-brand/10 font-medium text-brand"
                    : "text-foreground hover:bg-accent"
                }`}
              >
                {t("modules.help.allArticles")}
              </button>
              {collections.map((c) => {
                const key = c.slug ?? c.id;
                const active = activeCollection === key;
                return (
                  <button
                    key={c.id}
                    onClick={() => setCollection(key)}
                    className={`flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition ${
                      active ? "bg-brand/10 font-medium text-brand" : "text-foreground hover:bg-accent"
                    }`}
                  >
                    <span className="truncate">{c.name}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 opacity-40" />
                  </button>
                );
              })}
              {collections.length === 0 && (
                <p className="px-3 py-2 text-sm text-muted-foreground">{t("modules.help.noCollections")}</p>
              )}
            </nav>
          )}
        </aside>

        {/* 右側:內容 */}
        <section className="min-w-0">
          {/* 1) 搜尋結果 */}
          {inSearch ? (
            <SearchResults
              query={query}
              state={searchState}
              result={searchResult}
              onOpen={openArticle}
            />
          ) : inDetail ? (
            /* 2) 單篇文章 */
            <ArticleView state={articleState} article={article} onBack={backToList} />
          ) : (
            /* 3) 文章清單 + FAQ */
            <div className="space-y-10">
              <div>
                <h2 className="mb-4 text-lg font-semibold text-foreground">{collectionName}</h2>
                {artState === "loading" ? (
                  <Spinner />
                ) : artState === "error" ? (
                  <EmptyState icon={Inbox} text={t("modules.help.loadFailed")} />
                ) : articles.length === 0 ? (
                  <EmptyState icon={Inbox} text={t("modules.help.noArticles")} />
                ) : (
                  <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                    {articles.map((a) => (
                      <li key={a.id}>
                        <button
                          onClick={() => openArticle(a.id)}
                          className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition hover:bg-accent"
                        >
                          <FileText className="mt-0.5 h-4.5 w-4.5 shrink-0 text-brand" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">{a.title}</span>
                            {a.excerpt && (
                              <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                                {a.excerpt}
                              </span>
                            )}
                          </span>
                          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {artState === "ready" && articles.length < artTotal && (
                  <div className="mt-4 text-center">
                    <button
                      onClick={loadMore}
                      className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-accent"
                    >
                      {t("modules.help.loadMore", { loaded: articles.length, total: artTotal })}
                    </button>
                  </div>
                )}
              </div>

              {/* FAQ 區 */}
              {faqs.length > 0 && (
                <div>
                  <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-foreground">
                    <HelpCircle className="h-5 w-5 text-brand" /> {t("modules.help.faq")}
                  </h2>
                  <div className="space-y-2">
                    {faqs.map((f) => (
                      <details
                        key={f.id}
                        className="group overflow-hidden rounded-xl border border-border bg-card"
                      >
                        <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3.5 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
                          <span>{f.question}</span>
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-open:rotate-90" />
                        </summary>
                        <div
                          className="md-body border-t border-border px-4 py-3 text-sm text-muted-foreground"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(f.answer) }}
                        />
                      </details>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">
        {t("modules.help.footer")}
      </footer>
    </div>
  );
}

// ----------------------------- 子元件:單篇文章 -----------------------------
function ArticleView({
  state,
  article,
  onBack,
}: {
  state: "loading" | "ready" | "error";
  article: HelpArticle | null;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article className="min-w-0">
      <button
        onClick={onBack}
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {t("modules.help.backToList")}
      </button>

      {state === "loading" ? (
        <Spinner />
      ) : state === "error" || !article ? (
        <EmptyState icon={Inbox} text={t("modules.help.articleNotFound")} />
      ) : (
        <>
          <h1 className="text-2xl font-bold leading-snug text-foreground">{article.title}</h1>
          {article.created_at && (
            <p className="mt-2 text-xs text-muted-foreground">{t("modules.help.updatedAt", { date: fmtDate(article.created_at) })}</p>
          )}
          <div
            className="md-body mt-6 text-sm leading-relaxed text-foreground"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(article.content) }}
          />
          {article.source && /^https?:\/\//.test(article.source) && (
            <a
              href={article.source}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-8 inline-flex items-center gap-1.5 text-sm text-brand hover:underline"
            >
              <ExternalLink className="h-4 w-4" /> {t("modules.help.sourceRef")}
            </a>
          )}
        </>
      )}
    </article>
  );
}

// ----------------------------- 子元件:搜尋結果 -----------------------------
function SearchResults({
  query,
  state,
  result,
  onOpen,
}: {
  query: string;
  state: "idle" | "loading" | "ready" | "error";
  result: HelpSearchResult | null;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (state === "loading") return <Spinner label={t("modules.help.searching")} />;
  if (state === "error") return <EmptyState icon={Inbox} text={t("modules.help.searchFailed")} />;

  const articles = result?.articles ?? [];
  const faqs = result?.faqs ?? [];
  const empty = articles.length === 0 && faqs.length === 0;

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        「<span className="font-medium text-foreground">{query}</span>」{t("modules.help.searchResultsSuffix")}
        {result && t("modules.help.searchResultsCount", { articles: articles.length, faqs: faqs.length })}
      </p>

      {empty ? (
        <EmptyState icon={Search} text={t("modules.help.searchEmpty")} />
      ) : (
        <>
          {articles.length > 0 && (
            <div>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                <FileText className="h-4 w-4 text-brand" /> {t("modules.help.article")}
              </h3>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {articles.map((a) => (
                  <li key={a.id}>
                    <button
                      onClick={() => onOpen(a.id)}
                      className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition hover:bg-accent"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{a.title}</span>
                        {a.excerpt && (
                          <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                            {a.excerpt}
                          </span>
                        )}
                      </span>
                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {faqs.length > 0 && (
            <div>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                <HelpCircle className="h-4 w-4 text-brand" /> {t("modules.help.faq")}
              </h3>
              <div className="space-y-2">
                {faqs.map((f) => (
                  <details key={f.id} className="group overflow-hidden rounded-xl border border-border bg-card">
                    <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3.5 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
                      <span>{f.question}</span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-open:rotate-90" />
                    </summary>
                    <div
                      className="md-body border-t border-border px-4 py-3 text-sm text-muted-foreground"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(f.answer) }}
                    />
                  </details>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
