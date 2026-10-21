import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  workflowsApi,
  type NodeDef,
  type NodeNext,
  type RunResult,
  type WorkflowDto,
  type WorkflowInput,
} from "@/api/workflows";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** 分支型節點(next 為 {true,false})。與後端 catalog.branching 對齊。 */
const BRANCHING_TYPES = new Set(["condition"]);
const CONDITION_OPS = ["eq", "ne", "contains", "gt", "lt", "in"] as const;

/** 前端可用的節點型別(對齊後端 workflow_engine.NODE_TYPES)。 */
const NODE_TYPES = ["message", "condition", "ai_answer", "handoff", "add_tag", "end"] as const;
const TRIGGERS = ["manual", "session_start", "keyword", "message"] as const;

/** 編輯中的節點(config 一律具體化為物件,便於受控輸入)。 */
interface EditNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next: NodeNext | undefined;
}

const CTX_DEFAULT = '{\n  "content": "你好",\n  "query": "營業時間",\n  "vip": true\n}';

/** 把後端節點轉為可編輯結構。 */
function toEditNode(n: NodeDef): EditNode {
  return {
    id: n.id,
    type: n.type,
    config: { ...(n.config ?? {}) },
    next: n.next,
  };
}

/** condition value 顯示:字串原樣,其餘以 JSON 呈現(讓 true/5/"vip" 可讀可編)。 */
function valueToInput(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 反向:輸入字串嘗試解析為 JSON(true/數字/清單),失敗則當純字串。 */
function coerceValue(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return "";
  try {
    return JSON.parse(s);
  } catch {
    return raw;
  }
}

/** AI 工作流分頁:列表 + 清單式節點編輯器 + 手動執行測試。接真 API /workflows。 */
export function AiWorkflowsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const listQuery = useQuery({
    queryKey: ["workflows", "list"],
    queryFn: () => workflowsApi.list(),
  });

  // 選取 / 編輯狀態
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [lastSeed, setLastSeed] = useState<string | null>(null);

  // 表單欄位
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState<string>("manual");
  const [isActive, setIsActive] = useState(false);
  const [nodes, setNodes] = useState<EditNode[]>([]);

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 測試面板
  const [ctxText, setCtxText] = useState(CTX_DEFAULT);
  const [dryRun, setDryRun] = useState(true);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);

  const items = useMemo<WorkflowDto[]>(() => listQuery.data?.items ?? [], [listQuery.data]);
  const seedKey = isNew ? "__new__" : selectedId;
  const editing = isNew || selectedId !== null;

  function seedBlank() {
    setName("");
    setDescription("");
    setTrigger("manual");
    setIsActive(false);
    setNodes([]);
    setError(null);
    setRunResult(null);
  }

  function seedFrom(w: WorkflowDto) {
    setName(w.name ?? "");
    setDescription(w.description ?? "");
    setTrigger(w.trigger ?? "manual");
    setIsActive(!!w.is_active);
    setNodes((w.definition?.nodes ?? []).map(toEditNode));
    setError(null);
    setRunResult(null);
  }

  // 依選取播種一次(切換選取才重播,避免覆寫編輯中的表單)
  useEffect(() => {
    if (seedKey === lastSeed) return;
    if (isNew) {
      seedBlank();
    } else if (selectedId) {
      const w = items.find((x) => x.id === selectedId);
      if (w) seedFrom(w);
    }
    setLastSeed(seedKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey, lastSeed, isNew, selectedId, items]);

  const nodeIds = nodes.map((n) => n.id);

  function nextNodeId(): string {
    let i = nodes.length + 1;
    let id = `n${i}`;
    const existing = new Set(nodeIds);
    while (existing.has(id)) {
      i += 1;
      id = `n${i}`;
    }
    return id;
  }

  function updateNode(idx: number, patch: Partial<EditNode>) {
    setNodes((prev) => prev.map((n, i) => (i === idx ? { ...n, ...patch } : n)));
  }

  function updateConfig(idx: number, key: string, value: unknown) {
    setNodes((prev) =>
      prev.map((n, i) => (i === idx ? { ...n, config: { ...n.config, [key]: value } } : n)),
    );
  }

  function changeType(idx: number, type: string) {
    // 切換型別時重置分支結構,避免遺留不相容的 next 形狀
    const next: NodeNext | undefined = BRANCHING_TYPES.has(type) ? {} : undefined;
    updateNode(idx, { type, next });
  }

  function addNode() {
    const id = nextNodeId();
    setNodes((prev) => [...prev, { id, type: "message", config: {}, next: undefined }]);
  }

  function removeNode(idx: number) {
    setNodes((prev) => prev.filter((_, i) => i !== idx));
  }

  function moveNode(idx: number, dir: -1 | 1) {
    setNodes((prev) => {
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[j]] = [copy[j], copy[idx]];
      return copy;
    });
  }

  function buildDefinition(): WorkflowInput["definition"] {
    if (nodes.length === 0) return null; // 空流程 → 存為草稿
    return {
      start: nodes[0]?.id,
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        config: n.config,
        next: n.next,
      })),
    };
  }

  const save = useMutation({
    mutationFn: () => {
      const body: WorkflowInput = {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        trigger,
        is_active: isActive,
        definition: buildDefinition(),
      };
      return isNew ? workflowsApi.create(body) : workflowsApi.update(selectedId as string, body);
    },
    onSuccess: (data) => {
      setError(null);
      setSaved(true);
      setIsNew(false);
      setSelectedId(data.id);
      setLastSeed(data.id); // 防播種 effect 覆寫
      qc.invalidateQueries({ queryKey: ["workflows", "list"] });
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (e) =>
      setError(e instanceof Error ? e.message : t("workflows.saveError", { defaultValue: "儲存失敗" })),
  });

  const del = useMutation({
    mutationFn: (id: string) => workflowsApi.remove(id),
    onSuccess: () => {
      setSelectedId(null);
      setIsNew(false);
      setLastSeed(null);
      qc.invalidateQueries({ queryKey: ["workflows", "list"] });
    },
  });

  const run = useMutation({
    mutationFn: () => {
      let ctx: Record<string, unknown> = {};
      const raw = ctxText.trim();
      if (raw) {
        const parsed = JSON.parse(raw); // 失敗於下方 onError 捕捉
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          ctx = parsed as Record<string, unknown>;
        } else {
          throw new Error("ctx must be an object");
        }
      }
      return workflowsApi.run(selectedId as string, { ctx, dry_run: dryRun });
    },
    onSuccess: (resp) => {
      setRunError(null);
      setRunResult(resp.result);
    },
    onError: (e) => {
      setRunResult(null);
      if (e instanceof SyntaxError) {
        setRunError(t("workflows.test.ctxInvalid", { defaultValue: "ctx 不是合法 JSON" }));
      } else {
        setRunError(e instanceof Error ? e.message : t("workflows.saveError", { defaultValue: "執行失敗" }));
      }
    },
  });

  function handleDelete() {
    if (!selectedId) return;
    const msg = t("workflows.deleteConfirm", { defaultValue: "確定刪除此工作流?" });
    if (typeof window !== "undefined" && !window.confirm(msg)) return;
    del.mutate(selectedId);
  }

  // ---- 載入 / 錯誤 ----
  if (listQuery.isLoading) {
    return <Skeleton className="h-[32rem] w-full max-w-5xl" />;
  }
  if (listQuery.isError) {
    return (
      <Card className="max-w-2xl">
        <CardContent className="flex flex-col items-start gap-3 p-6">
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />{" "}
            {t("workflows.loadError", { defaultValue: "載入工作流失敗" })}
          </p>
          <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
            <RefreshCw className="h-4 w-4" /> {t("workflows.retry", { defaultValue: "重試" })}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const canSave = name.trim().length > 0 && !save.isPending;

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-4 lg:grid-cols-[18rem_1fr]">
      {/* 左:工作流列表 */}
      <div className="space-y-2">
        <Button
          className="w-full"
          onClick={() => {
            setIsNew(true);
            setSelectedId(null);
          }}
        >
          <Plus className="h-4 w-4" /> {t("workflows.new", { defaultValue: "新增工作流" })}
        </Button>

        {items.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {t("workflows.empty", { defaultValue: "尚無工作流,點上方新增。" })}
          </p>
        ) : (
          <div className="space-y-1.5">
            {items.map((w) => {
              const active = !isNew && selectedId === w.id;
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => {
                    setIsNew(false);
                    setSelectedId(w.id);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                    active
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-border hover:bg-accent",
                  )}
                >
                  <WorkflowIcon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  <Badge variant={w.is_active ? "default" : "secondary"} className="shrink-0">
                    {w.is_active
                      ? t("workflows.active", { defaultValue: "啟用" })
                      : t("workflows.inactive", { defaultValue: "停用" })}
                  </Badge>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 右:編輯器 */}
      <div className="min-w-0 space-y-4">
        {!editing ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 px-6 py-14 text-center text-sm text-muted-foreground">
              <WorkflowIcon className="h-6 w-6" />
              {t("workflows.selectHint", { defaultValue: "選擇左側工作流以編輯,或新增一個。" })}
            </CardContent>
          </Card>
        ) : (
          <>
            {/* 基本資訊 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  {isNew
                    ? t("workflows.createTitle", { defaultValue: "新增工作流" })
                    : t("workflows.editTitle", { defaultValue: "編輯工作流" })}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="wf-name">{t("workflows.form.name", { defaultValue: "名稱" })}</Label>
                  <Input
                    id="wf-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("workflows.form.namePlaceholder", { defaultValue: "例:新客歡迎流程" })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="wf-desc">
                    {t("workflows.form.description", { defaultValue: "描述" })}
                  </Label>
                  <Textarea
                    id="wf-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t("workflows.form.descriptionPlaceholder", {
                      defaultValue: "這個流程的用途(選填)",
                    })}
                    className="min-h-[64px]"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="wf-trigger">
                      {t("workflows.form.trigger", { defaultValue: "觸發時機" })}
                    </Label>
                    <select
                      id="wf-trigger"
                      value={trigger}
                      onChange={(e) => setTrigger(e.target.value)}
                      className={selectClass}
                    >
                      {TRIGGERS.map((tr) => (
                        <option key={tr} value={tr}>
                          {t(`workflows.trigger.${tr}`, { defaultValue: tr })}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-end">
                    <div className="flex w-full items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
                      <div className="space-y-0.5">
                        <Label htmlFor="wf-active">
                          {t("workflows.form.activeToggle", { defaultValue: "啟用" })}
                        </Label>
                        <p className="text-[11px] text-muted-foreground">
                          {t("workflows.form.activeHint", { defaultValue: "啟用後才會被觸發執行" })}
                        </p>
                      </div>
                      <Switch id="wf-active" checked={isActive} onCheckedChange={setIsActive} />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 節點編輯器 */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm">
                  {t("workflows.nodes.title", { defaultValue: "流程節點" })}
                </CardTitle>
                <Button variant="outline" size="sm" onClick={addNode}>
                  <Plus className="h-4 w-4" /> {t("workflows.nodes.add", { defaultValue: "新增節點" })}
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                {nodes.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                    {t("workflows.nodes.empty", {
                      defaultValue: "尚無節點。第一個節點即為流程起點。",
                    })}
                  </p>
                ) : (
                  nodes.map((node, idx) => (
                    <NodeEditor
                      key={node.id}
                      node={node}
                      index={idx}
                      total={nodes.length}
                      nodeIds={nodeIds}
                      onChangeType={(type) => changeType(idx, type)}
                      onChangeConfig={(k, v) => updateConfig(idx, k, v)}
                      onChangeNext={(next) => updateNode(idx, { next })}
                      onRemove={() => removeNode(idx)}
                      onMove={(dir) => moveNode(idx, dir)}
                    />
                  ))
                )}

                {/* 動作列 */}
                {error && <p className="text-xs text-destructive">{error}</p>}
                {saved && (
                  <p className="text-xs text-success">
                    {t("workflows.saved", { defaultValue: "已儲存" })}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => save.mutate()} disabled={!canSave}>
                    {save.isPending
                      ? t("workflows.saving", { defaultValue: "儲存中…" })
                      : t("workflows.save", { defaultValue: "儲存" })}
                  </Button>
                  {!isNew && selectedId && (
                    <Button
                      variant="outline"
                      className="text-destructive"
                      onClick={handleDelete}
                      disabled={del.isPending}
                    >
                      <Trash2 className="h-4 w-4" /> {t("workflows.delete", { defaultValue: "刪除" })}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* 執行測試 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  {t("workflows.test.title", { defaultValue: "執行測試" })}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {isNew ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                    {t("workflows.test.saveFirst", { defaultValue: "請先儲存工作流再執行測試。" })}
                  </p>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="wf-ctx">
                        {t("workflows.test.ctxLabel", { defaultValue: "測試脈絡(ctx,JSON)" })}
                      </Label>
                      <Textarea
                        id="wf-ctx"
                        value={ctxText}
                        onChange={(e) => setCtxText(e.target.value)}
                        className="min-h-[100px] font-mono text-xs"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {t("workflows.test.ctxHint", {
                          defaultValue:
                            "condition 依此比對;{var} 會以 ctx 內插。含 session_id 且關閉乾跑才會真正發訊息。",
                        })}
                      </p>
                    </div>

                    <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5">
                      <div className="space-y-0.5">
                        <Label htmlFor="wf-dry">
                          {t("workflows.test.dryRun", { defaultValue: "乾跑(不產生副作用)" })}
                        </Label>
                        <p className="text-[11px] text-muted-foreground">
                          {t("workflows.test.dryRunHint", {
                            defaultValue: "僅模擬流程,不真的發訊息 / 改會話 / 加標籤。",
                          })}
                        </p>
                      </div>
                      <Switch id="wf-dry" checked={dryRun} onCheckedChange={setDryRun} />
                    </div>

                    {runError && <p className="text-xs text-destructive">{runError}</p>}

                    <Button variant="outline" onClick={() => run.mutate()} disabled={run.isPending}>
                      <Play className="h-4 w-4" />{" "}
                      {run.isPending
                        ? t("workflows.test.running", { defaultValue: "執行中…" })
                        : t("workflows.test.run", { defaultValue: "執行測試" })}
                    </Button>

                    {runResult && <RunTrace result={runResult} />}
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// 子元件:單一節點編輯
// --------------------------------------------------------------------------- //
interface NodeEditorProps {
  node: EditNode;
  index: number;
  total: number;
  nodeIds: string[];
  onChangeType: (type: string) => void;
  onChangeConfig: (key: string, value: unknown) => void;
  onChangeNext: (next: NodeNext | undefined) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

function NodeEditor(props: NodeEditorProps) {
  const { t } = useTranslation();
  const { node, index, total, nodeIds, onChangeType, onChangeConfig, onChangeNext, onRemove, onMove } =
    props;

  const branching = BRANCHING_TYPES.has(node.type);
  // 可跳轉的目標:其他節點 + 「結束」(空值)
  const targets = nodeIds.filter((id) => id !== node.id);

  const cfg = (key: string): string => {
    const v = node.config[key];
    return v === undefined || v === null ? "" : String(v);
  };
  const linearNext = typeof node.next === "string" ? node.next : "";
  const branchNext = (k: "true" | "false"): string => {
    if (node.next && typeof node.next === "object") return (node.next[k] as string) ?? "";
    return "";
  };

  function setBranch(k: "true" | "false", value: string) {
    const base = node.next && typeof node.next === "object" ? { ...node.next } : {};
    if (value) base[k] = value;
    else delete base[k];
    onChangeNext(base);
  }

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <span className="font-mono text-[11px] text-muted-foreground">
          {index === 0
            ? t("workflows.nodes.startBadge", { defaultValue: "起點" })
            : `#${index + 1}`}
        </span>
        <code className="text-xs">{node.id}</code>
        <select
          value={node.type}
          onChange={(e) => onChangeType(e.target.value)}
          className={cn(selectClass, "ml-auto h-8 w-auto")}
          aria-label={t("workflows.nodes.type", { defaultValue: "型別" })}
        >
          {NODE_TYPES.map((ty) => (
            <option key={ty} value={ty}>
              {t(`workflows.nodeType.${ty}`, { defaultValue: ty })}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
          aria-label={t("workflows.nodes.moveUp", { defaultValue: "上移" })}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
          aria-label={t("workflows.nodes.moveDown", { defaultValue: "下移" })}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-destructive hover:bg-destructive/10"
          aria-label={t("workflows.nodes.remove", { defaultValue: "刪除節點" })}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-3 px-3 py-3">
        {/* 依型別呈現 config 欄位 */}
        {node.type === "message" && (
          <Field label={t("workflows.cfg.text", { defaultValue: "訊息內容" })}>
            <Textarea
              value={cfg("text")}
              onChange={(e) => onChangeConfig("text", e.target.value)}
              placeholder="您好 {name},很高興為您服務"
              className="min-h-[60px]"
            />
          </Field>
        )}

        {node.type === "ai_answer" && (
          <>
            <Field label={t("workflows.cfg.query", { defaultValue: "問題(留空取 ctx.query/content)" })}>
              <Input
                value={cfg("query")}
                onChange={(e) => onChangeConfig("query", e.target.value)}
                placeholder="{content}"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={node.config.send === true}
                onChange={(e) => onChangeConfig("send", e.target.checked)}
                className="h-4 w-4 accent-brand"
              />
              {t("workflows.cfg.send", { defaultValue: "把 AI 回覆直接發給訪客" })}
            </label>
          </>
        )}

        {node.type === "condition" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("workflows.cfg.field", { defaultValue: "ctx 欄位" })}>
              <Input
                value={cfg("field")}
                onChange={(e) => onChangeConfig("field", e.target.value)}
                placeholder="vip"
              />
            </Field>
            <Field label={t("workflows.cfg.op", { defaultValue: "運算子" })}>
              <select
                value={cfg("op") || "eq"}
                onChange={(e) => onChangeConfig("op", e.target.value)}
                className={selectClass}
              >
                {CONDITION_OPS.map((op) => (
                  <option key={op} value={op}>
                    {t(`workflows.op.${op}`, { defaultValue: op })}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("workflows.cfg.value", { defaultValue: "比對值" })}>
              <Input
                value={valueToInput(node.config.value)}
                onChange={(e) => onChangeConfig("value", coerceValue(e.target.value))}
                placeholder="true"
              />
            </Field>
          </div>
        )}

        {node.type === "handoff" && (
          <Field label={t("workflows.cfg.skillGroup", { defaultValue: "技能組 ID(選填)" })}>
            <Input
              value={cfg("skill_group_id")}
              onChange={(e) => onChangeConfig("skill_group_id", e.target.value)}
              placeholder="uuid"
              className="font-mono text-xs"
            />
          </Field>
        )}

        {node.type === "add_tag" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("workflows.cfg.tagName", { defaultValue: "標籤名稱" })}>
              <Input
                value={cfg("name")}
                onChange={(e) => onChangeConfig("name", e.target.value)}
                placeholder="VIP"
              />
            </Field>
            <Field label={t("workflows.cfg.tagId", { defaultValue: "或標籤 ID(選填)" })}>
              <Input
                value={cfg("tag_id")}
                onChange={(e) => onChangeConfig("tag_id", e.target.value)}
                placeholder="uuid"
                className="font-mono text-xs"
              />
            </Field>
          </div>
        )}

        {node.type === "end" && (
          <p className="text-xs text-muted-foreground">
            {t("workflows.cfg.endHint", { defaultValue: "此節點結束流程。" })}
          </p>
        )}

        {/* next 流轉 */}
        {node.type !== "end" &&
          (branching ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("workflows.nodes.branchTrue", { defaultValue: "成立時 →" })}>
                <NextSelect
                  value={branchNext("true")}
                  targets={targets}
                  onChange={(v) => setBranch("true", v)}
                />
              </Field>
              <Field label={t("workflows.nodes.branchFalse", { defaultValue: "不成立時 →" })}>
                <NextSelect
                  value={branchNext("false")}
                  targets={targets}
                  onChange={(v) => setBranch("false", v)}
                />
              </Field>
            </div>
          ) : (
            <Field label={t("workflows.nodes.next", { defaultValue: "下一步 →" })}>
              <NextSelect
                value={linearNext}
                targets={targets}
                onChange={(v) => onChangeNext(v || undefined)}
              />
            </Field>
          ))}
      </div>
    </div>
  );
}

/** next 目標下拉:節點 id 或「結束」(空值)。 */
function NextSelect(props: { value: string; targets: string[]; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const { value, targets, onChange } = props;
  // 目前值即使不在 targets(例如指向已刪節點)也保留為選項,避免落空
  const options = Array.from(new Set([...(value ? [value] : []), ...targets]));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
      <option value="">{t("workflows.nodes.nextEnd", { defaultValue: "(結束流程)" })}</option>
      {options.map((id) => (
        <option key={id} value={id}>
          {id}
        </option>
      ))}
    </select>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{props.label}</Label>
      {props.children}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// 子元件:執行軌跡
// --------------------------------------------------------------------------- //
function RunTrace(props: { result: RunResult }) {
  const { t } = useTranslation();
  const { result } = props;

  const statusTone: Record<string, string> = {
    completed: "text-success",
    stopped: "text-amber-600 dark:text-amber-400",
    error: "text-destructive",
    empty: "text-muted-foreground",
  };

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn("font-semibold", statusTone[result.status] ?? "")}>
          {t(`workflows.test.status.${result.status}`, { defaultValue: result.status })}
        </span>
        <span className="text-muted-foreground">
          · {t("workflows.test.steps", { defaultValue: "步數" })}: {result.steps}
        </span>
        {result.dry_run && (
          <Badge variant="secondary">
            {t("workflows.test.dryRunBadge", { defaultValue: "乾跑" })}
          </Badge>
        )}
      </div>

      {result.reason && (
        <p className="text-[11px] text-muted-foreground">
          {t("workflows.test.reason", { defaultValue: "說明" })}: {result.reason}
        </p>
      )}

      {result.trace.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {t("workflows.test.noTrace", { defaultValue: "無執行軌跡" })}
        </p>
      ) : (
        <ol className="space-y-1.5">
          {result.trace.map((entry, i) => (
            <li key={i} className="rounded border border-border bg-background px-2.5 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {i + 1}. {entry.node_id ?? "?"}
                </span>
                <code className="text-[11px]">{entry.type ?? "-"}</code>
                <span
                  className={cn(
                    "ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium",
                    entry.status === "error"
                      ? "bg-destructive/10 text-destructive"
                      : entry.status === "skip"
                        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {entry.status}
                </span>
              </div>
              {entry.info && Object.keys(entry.info).length > 0 && (
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
                  {JSON.stringify(entry.info, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
