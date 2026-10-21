import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRightLeft,
  Bot,
  Loader2,
  Quote,
  Send,
  SlidersHorizontal,
  Trash2,
  User,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { aiApi, knowledgeApi } from "@/api/endpoints";
import { playgroundApi } from "@/api/playground";
import type {
  PlaygroundChatRequest,
  PlaygroundReply,
  PlaygroundSource,
} from "@/api/playground";
import { cn } from "@/lib/utils";

/** 一則本地對話訊息;assistant 訊息帶完整回應 meta(信心/來源/handoff)。 */
interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  reply?: PlaygroundReply;
}

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function pct(v: number | null | undefined): number {
  return Math.round((typeof v === "number" ? v : 0) * 100);
}

/** 從 RAG source_ref 取一個可讀標籤(文件標題 / QA 問題 / 型別)。 */
function sourceLabel(s: PlaygroundSource, fallback: string): string {
  const ref = s.source_ref ?? {};
  const title = ref["title"];
  const question = ref["question"];
  const type = ref["type"];
  if (typeof title === "string" && title.trim()) return title;
  if (typeof question === "string" && question.trim()) return question;
  if (typeof type === "string" && type.trim()) return type;
  return fallback;
}

/**
 * AI 對話測試(Playground):管理員直接與 AI 客服對話測試。
 * 接 POST /playground/chat —— 不建立真實會話,可即時調參並觀察
 * 信心分、引用來源與是否會觸發轉人工。
 */
export function AiPlaygroundTab() {
  const { t } = useTranslation();

  // --- 對話狀態 ---
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // --- 測試參數 ---
  const [model, setModel] = useState("");
  const [manualModel, setManualModel] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [confidence, setConfidence] = useState(0.55);
  const [seededThreshold, setSeededThreshold] = useState(false);

  // --- 輔助資料(沿用既有端點:模型探測 / 知識庫集合 / 租戶設定門檻) ---
  const modelsQuery = useQuery({
    queryKey: ["ai", "models"],
    queryFn: () => aiApi.models(),
    retry: false,
  });
  const collectionsQuery = useQuery({
    queryKey: ["knowledge", "collections"],
    queryFn: () => knowledgeApi.collections(),
  });
  const configQuery = useQuery({
    queryKey: ["ai", "config"],
    queryFn: () => aiApi.getConfig(),
  });

  // 用租戶目前的信心門檻播種滑桿(僅首次,避免覆寫使用者調整)
  useEffect(() => {
    if (seededThreshold || !configQuery.isSuccess) return;
    const cfg = (configQuery.data ?? null) as { confidence_threshold?: number } | null;
    if (cfg && typeof cfg.confidence_threshold === "number") {
      setConfidence(cfg.confidence_threshold);
    }
    setSeededThreshold(true);
  }, [seededThreshold, configQuery.isSuccess, configQuery.data]);

  const probed = modelsQuery.data?.models ?? [];
  const probeUnavailable =
    modelsQuery.isError || (!modelsQuery.isLoading && probed.length === 0);
  const useManualModel = manualModel || probeUnavailable;
  const modelOptions = Array.from(new Set([...(model ? [model] : []), ...probed]));
  const collections = collectionsQuery.data ?? [];

  const send = useMutation({
    mutationFn: (req: PlaygroundChatRequest) => playgroundApi.chat(req),
    onSuccess: (data) => {
      setMessages((prev) => [...prev, { role: "assistant", content: data.answer, reply: data }]);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  // 訊息更新後捲到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, send.isPending]);

  function toggleCollection(id: string) {
    setCollectionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handleSend() {
    const text = input.trim();
    if (!text || send.isPending) return;
    const next: ChatMsg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setError(null);
    send.mutate({
      messages: next.map((m) => ({ role: m.role, content: m.content })),
      model: model.trim() || null,
      system_prompt: systemPrompt.trim() || null,
      collection_ids: collectionIds,
      confidence_threshold: confidence,
    });
  }

  function handleClear() {
    setMessages([]);
    setError(null);
    send.reset();
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* ---------------- 對話區 ---------------- */}
      <Card className="flex min-h-[32rem] flex-col lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-0.5">
            <CardTitle className="text-sm">{t("playground.title", { defaultValue: "AI 對話測試" })}</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              {t("playground.subtitle", {
                defaultValue: "直接與 AI 客服對話測試,不會建立真實會話。",
              })}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleClear} disabled={messages.length === 0}>
            <Trash2 className="h-4 w-4" />
            {t("playground.clear", { defaultValue: "清空對話" })}
          </Button>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col gap-3">
          {/* 訊息列表 */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pr-1" style={{ maxHeight: "26rem" }}>
            {messages.length === 0 && !send.isPending ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
                <Bot className="h-8 w-8" />
                <p className="text-sm font-medium">
                  {t("playground.emptyTitle", { defaultValue: "開始測試對話" })}
                </p>
                <p className="max-w-xs text-xs">
                  {t("playground.emptyHint", {
                    defaultValue: "在下方輸入訪客可能問的問題,查看 AI 會如何回覆。",
                  })}
                </p>
              </div>
            ) : (
              messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="flex max-w-[85%] items-start gap-2">
                      <div className="rounded-lg rounded-tr-sm bg-brand px-3 py-2 text-sm text-brand-foreground">
                        {m.content}
                      </div>
                      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand">
                        <User className="h-3.5 w-3.5" />
                      </div>
                    </div>
                  </div>
                ) : (
                  <AssistantBubble key={i} reply={m.reply} content={m.content} />
                ),
              )
            )}

            {send.isPending && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Bot className="h-3.5 w-3.5" />
                </div>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("playground.sending", { defaultValue: "生成中…" })}
              </div>
            )}
          </div>

          {error && (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t("playground.error", { defaultValue: "測試失敗" })}: {error}
            </p>
          )}

          {/* 輸入列 */}
          <div className="flex items-end gap-2 border-t border-border pt-3">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={t("playground.inputPlaceholder", {
                defaultValue: "輸入測試訊息…(Enter 送出,Shift+Enter 換行)",
              })}
              className="min-h-[44px] flex-1 resize-none"
              rows={1}
            />
            <Button onClick={handleSend} disabled={!input.trim() || send.isPending}>
              {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {t("playground.send", { defaultValue: "送出" })}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ---------------- 測試參數區 ---------------- */}
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5 text-sm">
            <SlidersHorizontal className="h-4 w-4" />
            {t("playground.paramsTitle", { defaultValue: "測試參數" })}
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            {t("playground.paramsHint", {
              defaultValue: "調整後直接送出訊息即可即時比較;留空則沿用租戶目前設定。",
            })}
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* 模型 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="pg-model">{t("playground.model", { defaultValue: "模型" })}</Label>
              {!probeUnavailable && (
                <button
                  type="button"
                  onClick={() => setManualModel((v) => !v)}
                  className="text-[11px] text-brand hover:underline"
                >
                  {useManualModel
                    ? t("playground.modelPickToggle", { defaultValue: "從清單挑選" })
                    : t("playground.modelManualToggle", { defaultValue: "手動輸入" })}
                </button>
              )}
            </div>
            {modelsQuery.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : useManualModel ? (
              <Input
                id="pg-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={t("playground.modelManualPlaceholder", {
                  defaultValue: "輸入模型名稱,如 gpt-4o-mini",
                })}
                className="font-mono text-xs"
              />
            ) : (
              <select
                id="pg-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={cn(selectClass, "font-mono text-xs")}
              >
                <option value="">{t("playground.modelUseDefault", { defaultValue: "沿用租戶預設" })}</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            {probeUnavailable && (
              <p className="text-[11px] text-muted-foreground">
                {modelsQuery.isError
                  ? t("playground.modelProbeError", {
                      defaultValue: "模型探測失敗,請手動輸入模型名稱。",
                    })
                  : t("playground.modelEmpty", { defaultValue: "未探測到可用模型,請手動輸入。" })}
              </p>
            )}
          </div>

          {/* 系統提示詞覆寫 */}
          <div className="space-y-1.5">
            <Label htmlFor="pg-prompt">{t("playground.systemPrompt", { defaultValue: "系統提示詞覆寫" })}</Label>
            <Textarea
              id="pg-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("playground.systemPromptPlaceholder", {
                defaultValue: "留空 = 沿用租戶設定的人格/規則",
              })}
              className="min-h-[90px] text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              {t("playground.systemPromptHint", { defaultValue: "僅本次測試生效,不會存回租戶設定。" })}
            </p>
          </div>

          {/* 知識庫範圍 */}
          <div className="space-y-1.5">
            <Label>{t("playground.collections", { defaultValue: "知識庫範圍" })}</Label>
            <p className="text-[11px] text-muted-foreground">
              {t("playground.collectionsHint", { defaultValue: "不選 = 檢索全部知識庫。" })}
            </p>
            {collectionsQuery.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : collections.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-foreground">
                {t("playground.collectionsEmpty", {
                  defaultValue: "尚無知識庫;AI 將以純模型能力作答。",
                })}
              </p>
            ) : (
              <div className="space-y-1.5">
                {collections.map((c) => {
                  const checked = collectionIds.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                        checked ? "border-brand bg-brand/10" : "border-border hover:bg-accent",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCollection(c.id)}
                        className="h-4 w-4 accent-brand"
                      />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {t("playground.collectionsDocCount", {
                          count: c.doc_count,
                          defaultValue: "{{count}} 筆",
                        })}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* 信心門檻(轉人) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="pg-confidence">
                {t("playground.confidenceThreshold", { defaultValue: "信心門檻(轉人)" })}
              </Label>
              <span className="font-mono text-xs text-muted-foreground">
                {confidence.toFixed(2)} · {Math.round(confidence * 100)}%
              </span>
            </div>
            <input
              id="pg-confidence"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={confidence}
              onChange={(e) => setConfidence(Number(e.target.value))}
              className="w-full cursor-pointer accent-brand"
            />
            <p className="text-[11px] text-muted-foreground">
              {t("playground.confidenceHint", {
                defaultValue: "AI 回覆信心低於此值時,線上會觸發轉接真人。",
              })}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** AI 回覆氣泡:內容 + 信心分 + 是否會轉人工 + 引用來源。 */
function AssistantBubble({ reply, content }: { reply?: PlaygroundReply; content: string }) {
  const { t } = useTranslation();
  const confidence = reply?.confidence ?? 0;
  const threshold = reply?.config.confidence_threshold ?? 0;
  const meets = confidence >= threshold;
  const sources = reply?.sources ?? [];

  return (
    <div className="flex justify-start">
      <div className="flex max-w-[90%] items-start gap-2">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 space-y-2">
          <div className="whitespace-pre-wrap rounded-lg rounded-tl-sm bg-muted px-3 py-2 text-sm text-foreground">
            {content}
          </div>

          {/* 信心分 + handoff 提示 */}
          {reply && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={meets ? "success" : "warning"}>
                {t("playground.confidence", { defaultValue: "信心" })} {pct(confidence)}%
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {t("playground.thresholdInline", {
                  threshold: pct(threshold),
                  defaultValue: "門檻 {{threshold}}%",
                })}
              </span>
              {reply.would_handoff && (
                <Badge variant="destructive">
                  <ArrowRightLeft className="h-3 w-3" />
                  {t("playground.wouldHandoff", { defaultValue: "會轉接真人" })}
                </Badge>
              )}
            </div>
          )}

          {reply?.would_handoff && (
            <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              {t("playground.wouldHandoffHint", {
                defaultValue: "此回覆信心低於門檻,線上會改由真人接手,不自動回覆。",
              })}
            </p>
          )}

          {/* 引用來源 */}
          {reply &&
            (sources.length > 0 ? (
              <details className="rounded-md border border-border text-xs">
                <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 font-medium">
                  <Quote className="h-3.5 w-3.5" />
                  {t("playground.sourcesCount", {
                    count: sources.length,
                    defaultValue: "引用來源({{count}})",
                  })}
                </summary>
                <div className="space-y-2 border-t border-border px-2.5 py-2">
                  {sources.map((s) => (
                    <div key={s.index} className="space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] text-muted-foreground">[{s.index}]</span>
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {sourceLabel(s, t("playground.sourceUnknown", { defaultValue: "未具名來源" }))}
                        </span>
                        <Badge variant="secondary">
                          {t("playground.sourceScore", {
                            score: pct(s.score),
                            defaultValue: "相似度 {{score}}%",
                          })}
                        </Badge>
                      </div>
                      {s.content && (
                        <p className="line-clamp-3 text-[11px] text-muted-foreground">{s.content}</p>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {t("playground.noSources", { defaultValue: "此回覆未命中任何知識庫片段。" })}
              </p>
            ))}
        </div>
      </div>
    </div>
  );
}
