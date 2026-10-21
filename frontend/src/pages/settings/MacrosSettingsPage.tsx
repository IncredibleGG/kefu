import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2, ArrowUp, ArrowDown, X } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { iamApi, visitorApi } from "@/api/endpoints";
import { macrosApi, type Macro, type MacroAction, type MacroActionType } from "@/api/macros";

const ACTION_TYPES: MacroActionType[] = ["reply", "set_status", "add_tags", "assign", "add_note"];
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** 依型別產生一個帶預設值的空動作。 */
function blankAction(type: MacroActionType): MacroAction {
  switch (type) {
    case "reply":
    case "add_note":
      return { type, content: "" };
    case "set_status":
      return { type, value: "resolved" };
    case "add_tags":
      return { type, tags: [] };
    case "assign":
      return { type, staff_id: "" };
  }
}

/** 單個動作是否已填妥必填欄位(送出前的前端把關;後端另有驗證)。 */
function actionValid(a: MacroAction): boolean {
  switch (a.type) {
    case "reply":
    case "add_note":
      return !!a.content && a.content.trim() !== "";
    case "set_status":
      return !!a.value && a.value.trim() !== "";
    case "add_tags":
      return Array.isArray(a.tags) && a.tags.length > 0;
    case "assign":
      return true; // 省略 staff_id = 指派給自己
  }
}

export function MacrosSettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data: macros, isLoading, isError } = useQuery({
    queryKey: ["macros"],
    queryFn: () => macrosApi.list(),
  });
  // 動作編輯器需要的參照資料:標籤(add_tags)、坐席(assign)
  const { data: tags } = useQuery({ queryKey: ["visitor", "tags"], queryFn: () => visitorApi.listTags() });
  const { data: staff } = useQuery({ queryKey: ["iam", "staff", "lite"], queryFn: () => iamApi.staff() });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Macro | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [actions, setActions] = useState<MacroAction[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setIsActive(true);
    setActions([]);
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(m: Macro) {
    setEditing(m);
    setName(m.name);
    setDescription(m.description ?? "");
    setIsActive(m.is_active);
    setActions((m.actions ?? []).map((a) => ({ ...a })));
    setFormError(null);
    setDialogOpen(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        actions,
        is_active: isActive,
      };
      return editing ? macrosApi.update(editing.id, body) : macrosApi.create(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["macros"] });
      setDialogOpen(false);
    },
    onError: (e) => setFormError(e instanceof Error ? e.message : t("macros.saveError", { defaultValue: "儲存巨集失敗" })),
  });

  const remove = useMutation({
    mutationFn: (id: string) => macrosApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["macros"] }),
  });

  function submit() {
    setFormError(null);
    if (!name.trim()) {
      setFormError(t("macros.nameRequired", { defaultValue: "請輸入巨集名稱" }));
      return;
    }
    if (actions.some((a) => !actionValid(a))) {
      setFormError(t("macros.actionIncomplete", { defaultValue: "有動作尚未填妥必填欄位" }));
      return;
    }
    save.mutate();
  }

  // --- 動作序列操作(immutable) ---
  function addAction() {
    setActions((prev) => [...prev, blankAction("reply")]);
  }
  function updateAction(idx: number, patch: Partial<MacroAction>) {
    setActions((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  }
  function changeType(idx: number, type: MacroActionType) {
    setActions((prev) => prev.map((a, i) => (i === idx ? blankAction(type) : a)));
  }
  function removeAction(idx: number) {
    setActions((prev) => prev.filter((_, i) => i !== idx));
  }
  function moveAction(idx: number, dir: -1 | 1) {
    setActions((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }
  function toggleTag(idx: number, tagId: string) {
    setActions((prev) =>
      prev.map((a, i) => {
        if (i !== idx) return a;
        const cur = a.tags ?? [];
        return { ...a, tags: cur.includes(tagId) ? cur.filter((x) => x !== tagId) : [...cur, tagId] };
      }),
    );
  }

  const actionLabels = useMemo(
    () => ({
      reply: t("macros.action.reply", { defaultValue: "插入回覆" }),
      set_status: t("macros.action.set_status", { defaultValue: "設定狀態" }),
      add_tags: t("macros.action.add_tags", { defaultValue: "加標籤" }),
      assign: t("macros.action.assign", { defaultValue: "指派" }),
      add_note: t("macros.action.add_note", { defaultValue: "加備註" }),
    }),
    [t],
  );

  return (
    <PageShell
      title={t("macros.pageTitle", { defaultValue: "巨集管理" })}
      description={t("macros.pageDescription", {
        defaultValue: "建立可一鍵套用的複合動作(回覆 / 狀態 / 標籤 / 指派 / 備註)。",
      })}
      actions={
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" /> {t("macros.create", { defaultValue: "新增巨集" })}
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton className="h-64 max-w-2xl" />
      ) : isError ? (
        <Card className="max-w-2xl">
          <CardContent className="py-8">
            <p className="text-sm text-destructive">{t("macros.loadError", { defaultValue: "載入巨集失敗" })}</p>
          </CardContent>
        </Card>
      ) : !macros || macros.length === 0 ? (
        <Card className="max-w-2xl">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("macros.empty", { defaultValue: "尚無可用巨集" })}
          </CardContent>
        </Card>
      ) : (
        <div className="max-w-2xl space-y-2">
          {macros.map((m) => (
            <Card key={m.id}>
              <CardContent className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{m.name}</span>
                    {!m.is_active && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("macros.inactive", { defaultValue: "停用" })}
                      </Badge>
                    )}
                  </div>
                  {m.description && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{m.description}</p>
                  )}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(m.actions ?? []).map((a, i) => (
                      <Badge key={i} variant="outline" className="text-[10px]">
                        {actionLabels[a.type]}
                      </Badge>
                    ))}
                    {(m.actions ?? []).length === 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        {t("macros.noActions", { defaultValue: "尚未加入任何動作" })}
                      </span>
                    )}
                  </div>
                </div>
                <Button variant="ghost" size="icon-sm" aria-label={t("macros.edit", { defaultValue: "編輯巨集" })} onClick={() => openEdit(m)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("macros.delete", { defaultValue: "刪除" })}
                  onClick={() => {
                    if (window.confirm(t("macros.confirmDelete", { defaultValue: "確定刪除此巨集?此操作無法復原。" })))
                      remove.mutate(m.id);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("macros.edit", { defaultValue: "編輯巨集" })
                : t("macros.create", { defaultValue: "新增巨集" })}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="macro-name">{t("macros.name", { defaultValue: "名稱" })}</Label>
              <Input
                id="macro-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("macros.namePlaceholder", { defaultValue: "例如:結案並致謝" })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="macro-desc">{t("macros.description", { defaultValue: "說明" })}</Label>
              <Input
                id="macro-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("macros.descriptionPlaceholder", { defaultValue: "選填,說明此巨集用途" })}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <span className="text-sm">{t("macros.active", { defaultValue: "啟用" })}</span>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </div>

            {/* 動作序列 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("macros.actions", { defaultValue: "動作序列" })}</Label>
                <Button variant="outline" size="sm" onClick={addAction}>
                  <Plus className="h-3.5 w-3.5" /> {t("macros.addAction", { defaultValue: "新增動作" })}
                </Button>
              </div>

              {actions.length === 0 && (
                <p className="rounded-md border border-dashed border-border p-3 text-center text-[11px] text-muted-foreground">
                  {t("macros.noActions", { defaultValue: "尚未加入任何動作" })}
                </p>
              )}

              {actions.map((a, idx) => (
                <div key={idx} className="space-y-2 rounded-md border border-border p-2.5">
                  <div className="flex items-center gap-1.5">
                    <select
                      className={SELECT_CLASS}
                      value={a.type}
                      onChange={(e) => changeType(idx, e.target.value as MacroActionType)}
                      aria-label={t("macros.actionType", { defaultValue: "動作型別" })}
                    >
                      {ACTION_TYPES.map((tp) => (
                        <option key={tp} value={tp}>
                          {actionLabels[tp]}
                        </option>
                      ))}
                    </select>
                    <Button variant="ghost" size="icon-sm" aria-label={t("macros.moveUp", { defaultValue: "上移" })} onClick={() => moveAction(idx, -1)} disabled={idx === 0}>
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={t("macros.moveDown", { defaultValue: "下移" })} onClick={() => moveAction(idx, 1)} disabled={idx === actions.length - 1}>
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={t("macros.removeAction", { defaultValue: "移除" })} onClick={() => removeAction(idx)}>
                      <X className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>

                  {/* 型別專屬欄位 */}
                  {(a.type === "reply" || a.type === "add_note") && (
                    <Textarea
                      rows={3}
                      value={a.content ?? ""}
                      onChange={(e) => updateAction(idx, { content: e.target.value })}
                      placeholder={
                        a.type === "reply"
                          ? t("macros.replyContent", { defaultValue: "回覆內容" })
                          : t("macros.noteContent", { defaultValue: "備註內容" })
                      }
                      className="text-xs"
                    />
                  )}

                  {a.type === "set_status" && (
                    <div className="space-y-1">
                      <select
                        className={SELECT_CLASS}
                        value={a.value ?? "resolved"}
                        onChange={(e) => updateAction(idx, { value: e.target.value })}
                        aria-label={t("macros.statusValue", { defaultValue: "目標狀態" })}
                      >
                        <option value="resolved">{t("macros.statusResolvedOption", { defaultValue: "結束 / 已解決" })}</option>
                        <option value="pending">pending</option>
                        <option value="open">open</option>
                      </select>
                      <p className="text-[11px] text-muted-foreground">
                        {t("macros.statusHint", {
                          defaultValue: "目前僅「結束 / 已解決」會呼叫後端結束會話;其餘狀態於套用時標為待接。",
                        })}
                      </p>
                    </div>
                  )}

                  {a.type === "add_tags" && (
                    <div className="space-y-1">
                      {tags && tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {tags.map((tg) => {
                            const on = (a.tags ?? []).includes(tg.id);
                            return (
                              <button
                                key={tg.id}
                                type="button"
                                onClick={() => toggleTag(idx, tg.id)}
                                className={
                                  "rounded-full border px-2 py-0.5 text-[11px] transition-colors " +
                                  (on
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-border hover:bg-accent")
                                }
                              >
                                {tg.name}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">
                          {t("macros.tagsEmpty", { defaultValue: "尚未建立標籤,請先於「設定 → 標籤」新增。" })}
                        </p>
                      )}
                      <p className="text-[11px] text-muted-foreground">
                        {t("macros.tagsHint", { defaultValue: "套用時對目前會話加上所選標籤。" })}
                      </p>
                    </div>
                  )}

                  {a.type === "assign" && (
                    <select
                      className={SELECT_CLASS}
                      value={a.staff_id ?? ""}
                      onChange={(e) => updateAction(idx, { staff_id: e.target.value })}
                      aria-label={t("macros.assignTo", { defaultValue: "指派給" })}
                    >
                      <option value="">{t("macros.assignSelf", { defaultValue: "(指派給自己)" })}</option>
                      {(staff ?? []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.display_name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </div>

            {formError && <p className="text-xs text-destructive">{formError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("macros.cancel", { defaultValue: "取消" })}
            </Button>
            <Button onClick={submit} disabled={save.isPending || !name.trim()}>
              {save.isPending ? (
                t("macros.saving", { defaultValue: "儲存中…" })
              ) : (
                <>
                  <Check className="h-4 w-4" /> {t("macros.save", { defaultValue: "儲存" })}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
