import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { aiApi, knowledgeApi } from "@/api/endpoints";
import { cn } from "@/lib/utils";

/** 後端 /ai/config 回傳形狀(欄位皆選填;查無設定時為 null)。 */
interface AgentConfig {
  id?: string;
  name?: string | null;
  system_prompt?: string | null;
  provider?: string | null;
  model?: string | null;
  temperature?: number | null;
  collection_ids?: string[] | null;
  top_k?: number | null;
  confidence_threshold?: number | null;
  handoff_enabled?: boolean | null;
  is_active?: boolean | null;
}

const DEFAULTS = {
  name: "Default Agent",
  temperature: 0.3,
  top_k: 5,
  confidence_threshold: 0.55,
  handoff_enabled: true,
  is_active: true,
};

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** AI 代理設定表單:接 GET/PUT /ai/config + /ai/models 探測 + 知識庫集合多選。 */
export function AgentConfigForm() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const configQuery = useQuery({ queryKey: ["ai", "config"], queryFn: () => aiApi.getConfig() });
  // 模型探測:端點可能 502(BYO endpoint 無 /models),故 retry:false,失敗改手動輸入。
  const modelsQuery = useQuery({ queryKey: ["ai", "models"], queryFn: () => aiApi.models(), retry: false });
  const collectionsQuery = useQuery({
    queryKey: ["knowledge", "collections"],
    queryFn: () => knowledgeApi.collections(),
  });

  // ---- 表單狀態(以 config 首次載入播種) ----
  const [seeded, setSeeded] = useState(false);
  const [name, setName] = useState(DEFAULTS.name);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState("");
  const [manualModel, setManualModel] = useState(false);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [confidence, setConfidence] = useState(DEFAULTS.confidence_threshold);
  const [handoff, setHandoff] = useState(DEFAULTS.handoff_enabled);
  const [temperature, setTemperature] = useState(DEFAULTS.temperature);
  const [topK, setTopK] = useState(DEFAULTS.top_k);
  const [isActive, setIsActive] = useState(DEFAULTS.is_active);

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyConfig(c: AgentConfig | null | undefined) {
    const cfg = c ?? {};
    setName(cfg.name ?? DEFAULTS.name);
    setSystemPrompt(cfg.system_prompt ?? "");
    setModel(cfg.model ?? "");
    setCollectionIds(Array.isArray(cfg.collection_ids) ? cfg.collection_ids : []);
    setConfidence(cfg.confidence_threshold ?? DEFAULTS.confidence_threshold);
    setHandoff(cfg.handoff_enabled ?? DEFAULTS.handoff_enabled);
    setTemperature(cfg.temperature ?? DEFAULTS.temperature);
    setTopK(cfg.top_k ?? DEFAULTS.top_k);
    setIsActive(cfg.is_active ?? DEFAULTS.is_active);
  }

  // 首次載入成功才播種(避免背景 refetch 覆寫使用者編輯中的表單)
  useEffect(() => {
    if (seeded || !configQuery.isSuccess) return;
    applyConfig(configQuery.data as AgentConfig | null);
    setSeeded(true);
  }, [seeded, configQuery.isSuccess, configQuery.data]);

  const probed = modelsQuery.data?.models ?? [];
  const probeUnavailable =
    modelsQuery.isError || (!modelsQuery.isLoading && probed.length === 0);
  const useManualModel = manualModel || probeUnavailable;
  // 下拉一定含目前值(即使不在探測清單內),避免選項落空
  const modelOptions = Array.from(new Set([...(model ? [model] : []), ...probed]));

  function toggleCollection(id: string) {
    setCollectionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        model: model.trim() || null,
        temperature,
        collection_ids: collectionIds,
        top_k: topK,
        confidence_threshold: confidence,
        handoff_enabled: handoff,
        is_active: isActive,
      };
      // name / system_prompt 於後端為 NOT NULL(且有預設):留空時省略,保留既有 / 系統預設值。
      const nm = name.trim();
      if (nm) body.name = nm;
      if (systemPrompt.trim()) body.system_prompt = systemPrompt;
      return aiApi.upsertConfig(body);
    },
    onSuccess: (data) => {
      applyConfig(data as AgentConfig);
      setSaved(true);
      setError(null);
      qc.invalidateQueries({ queryKey: ["ai", "config"] });
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (e) => setError(e instanceof Error ? e.message : t("ai.config.saveError")),
  });

  // ---- 載入 / 錯誤 ----
  if (configQuery.isLoading) {
    return <Skeleton className="h-[32rem] max-w-2xl" />;
  }
  if (configQuery.isError) {
    return (
      <Card className="max-w-2xl">
        <CardContent className="flex flex-col items-start gap-3 p-6">
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {t("ai.config.loadError")}
          </p>
          <Button variant="outline" size="sm" onClick={() => configQuery.refetch()}>
            <RefreshCw className="h-4 w-4" /> {t("ai.config.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const collections = collectionsQuery.data ?? [];
  const isNew = (configQuery.data ?? null) === null;

  return (
    <div className="max-w-2xl space-y-4">
      {isNew && (
        <div className="rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-xs text-muted-foreground">
          {t("ai.config.emptyNotice")}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("ai.config.cardTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* 代理名稱 */}
          <div className="space-y-1.5">
            <Label htmlFor="ai-name">{t("ai.config.name")}</Label>
            <Input
              id="ai-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("ai.config.namePlaceholder")}
            />
          </div>

          {/* LLM 模型(探測下拉 / 手動輸入) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="ai-model">{t("ai.config.model")}</Label>
              {!probeUnavailable && (
                <button
                  type="button"
                  onClick={() => setManualModel((v) => !v)}
                  className="text-[11px] text-brand hover:underline"
                >
                  {useManualModel ? t("ai.config.modelPickToggle") : t("ai.config.modelManualToggle")}
                </button>
              )}
            </div>

            {modelsQuery.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : useManualModel ? (
              <Input
                id="ai-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={t("ai.config.modelManualPlaceholder")}
                className="font-mono text-xs"
              />
            ) : (
              <select
                id="ai-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={cn(selectClass, "font-mono text-xs")}
              >
                <option value="">{t("ai.config.modelUseDefault")}</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}

            {probeUnavailable ? (
              <p className="text-[11px] text-muted-foreground">
                {modelsQuery.isError ? t("ai.config.modelProbeError") : t("ai.config.modelEmpty")}
              </p>
            ) : (
              modelsQuery.data && (
                <p className="text-[11px] text-muted-foreground">
                  {t("ai.config.modelProbeSource", {
                    provider: modelsQuery.data.provider,
                    base: modelsQuery.data.base_url,
                  })}
                  {modelsQuery.data.default
                    ? ` · ${t("ai.config.modelDefaultHint", { model: modelsQuery.data.default })}`
                    : ""}
                </p>
              )
            )}
          </div>

          {/* 系統提示詞 */}
          <div className="space-y-1.5">
            <Label htmlFor="ai-prompt">{t("ai.config.systemPrompt")}</Label>
            <Textarea
              id="ai-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("ai.config.systemPromptPlaceholder")}
              className="min-h-[120px]"
            />
            <p className="text-[11px] text-muted-foreground">{t("ai.config.systemPromptHint")}</p>
          </div>

          {/* 掛接知識庫(多選) */}
          <div className="space-y-1.5">
            <Label>{t("ai.config.collections")}</Label>
            <p className="text-[11px] text-muted-foreground">{t("ai.config.collectionsHint")}</p>
            {collectionsQuery.isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : collections.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                {t("ai.config.collectionsEmpty")}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
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
                        {t("ai.config.collectionsDocCount", { count: c.doc_count })}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* 信心門檻 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="ai-confidence">{t("ai.config.confidenceThreshold")}</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {confidence.toFixed(2)} · {Math.round(confidence * 100)}%
              </span>
            </div>
            <input
              id="ai-confidence"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={confidence}
              onChange={(e) => setConfidence(Number(e.target.value))}
              className="w-full cursor-pointer accent-brand"
            />
            <p className="text-[11px] text-muted-foreground">{t("ai.config.confidenceHint")}</p>
          </div>

          {/* 低於門檻自動轉真人 */}
          <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5">
            <div className="space-y-0.5">
              <Label htmlFor="ai-handoff">{t("ai.config.handoff")}</Label>
              <p className="text-[11px] text-muted-foreground">{t("ai.config.handoffHint")}</p>
            </div>
            <Switch id="ai-handoff" checked={handoff} onCheckedChange={setHandoff} />
          </div>

          {/* 啟用開關 */}
          <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5">
            <div className="space-y-0.5">
              <Label htmlFor="ai-active">{t("ai.config.active")}</Label>
              <p className="text-[11px] text-muted-foreground">{t("ai.config.activeHint")}</p>
            </div>
            <Switch id="ai-active" checked={isActive} onCheckedChange={setIsActive} />
          </div>

          {/* 進階設定 */}
          <details className="rounded-md border border-border">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
              {t("ai.config.advanced")}
            </summary>
            <div className="space-y-4 border-t border-border px-3 py-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="ai-temp">{t("ai.config.temperature")}</Label>
                  <span className="font-mono text-xs text-muted-foreground">{temperature.toFixed(1)}</span>
                </div>
                <input
                  id="ai-temp"
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="w-full cursor-pointer accent-brand"
                />
                <p className="text-[11px] text-muted-foreground">{t("ai.config.temperatureHint")}</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ai-topk">{t("ai.config.topK")}</Label>
                <Input
                  id="ai-topk"
                  type="number"
                  min={1}
                  max={50}
                  value={topK}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) setTopK(Math.max(1, Math.min(50, Math.round(n))));
                  }}
                  className="w-28"
                />
                <p className="text-[11px] text-muted-foreground">{t("ai.config.topKHint")}</p>
              </div>
            </div>
          </details>

          {/* 動作列 */}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {saved && <p className="text-xs text-success">{t("ai.config.saved")}</p>}
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? t("ai.config.saving") : t("ai.config.save")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
