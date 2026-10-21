import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/api/client";
import {
  fieldsApi,
  type FieldDefinition,
  type FieldEntity,
  type FieldType,
} from "@/api/fields";

/* ------------------------------ 常數 / 樣式 ------------------------------ */
const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export const FIELD_TYPES: FieldType[] = [
  "text",
  "textarea",
  "number",
  "date",
  "select",
  "checkbox",
  "url",
];

/** 查詢某實體的自訂欄位定義(供設定與工單表單共用一致的 queryKey)。 */
export function useFieldDefs(entity: FieldEntity = "ticket") {
  return useQuery({
    queryKey: ["fields", entity],
    queryFn: () => fieldsApi.list(entity),
  });
}

/* ============================ 欄位設定對話框 ============================ */
/** 從 TicketsPage 開啟:列出 / 新增 / 編輯 / 刪除工單自訂欄位定義。 */
export function FieldSettingsDialog({
  open,
  onClose,
  entity = "ticket",
}: {
  open: boolean;
  onClose: () => void;
  entity?: FieldEntity;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const listQuery = useFieldDefs(entity);
  const fields = listQuery.data ?? [];

  // 編輯中的欄位(null 表示新增模式)
  const [editing, setEditing] = useState<FieldDefinition | null>(null);
  // 表單狀態
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [fieldType, setFieldType] = useState<FieldType>("text");
  const [optionsText, setOptionsText] = useState("");
  const [required, setRequired] = useState(false);
  const [sortOrder, setSortOrder] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);

  function resetForm() {
    setEditing(null);
    setLabel("");
    setKey("");
    setFieldType("text");
    setOptionsText("");
    setRequired(false);
    setSortOrder(0);
    setFormError(null);
  }

  function startEdit(f: FieldDefinition) {
    setEditing(f);
    setLabel(f.label);
    setKey(f.key);
    setFieldType(f.field_type);
    setOptionsText((f.options ?? []).join("\n"));
    setRequired(f.required);
    setSortOrder(f.sort_order);
    setFormError(null);
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ["fields", entity] });

  const saveMut = useMutation({
    mutationFn: async () => {
      const options =
        fieldType === "select"
          ? optionsText
              .split("\n")
              .map((o) => o.trim())
              .filter(Boolean)
          : null;
      if (editing) {
        return fieldsApi.update(editing.id, {
          label: label.trim(),
          field_type: fieldType,
          options,
          required,
          sort_order: sortOrder,
        });
      }
      return fieldsApi.create({
        entity,
        key: key.trim(),
        label: label.trim(),
        field_type: fieldType,
        options,
        required,
        sort_order: sortOrder,
      });
    },
    onSuccess: () => {
      invalidate();
      resetForm();
    },
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : "";
      setFormError(
        code === "FIELD_KEY_EXISTS"
          ? t("fields.errorConflict", { defaultValue: "此欄位鍵已存在,請換一個" })
          : t("fields.error", { defaultValue: "操作失敗,請稍後再試" }),
      );
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => fieldsApi.remove(id),
    onSuccess: (_data, id) => {
      invalidate();
      if (editing?.id === id) resetForm();
    },
  });

  const keyRe = /^[A-Za-z][A-Za-z0-9_]*$/;
  function submit() {
    setFormError(null);
    if (!label.trim()) {
      setFormError(t("fields.form.labelRequired", { defaultValue: "請輸入顯示名稱" }));
      return;
    }
    if (!editing) {
      if (!key.trim()) {
        setFormError(t("fields.form.keyRequired", { defaultValue: "請輸入欄位鍵" }));
        return;
      }
      if (!keyRe.test(key.trim())) {
        setFormError(
          t("fields.form.keyInvalid", {
            defaultValue: "欄位鍵格式不正確(英數與底線,需英文開頭)",
          }),
        );
        return;
      }
    }
    saveMut.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          resetForm();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("fields.settings.title", { defaultValue: "工單自訂欄位" })}</DialogTitle>
          <DialogDescription>
            {t("fields.settings.description", {
              defaultValue: "管理工單的自訂欄位:顯示名稱、鍵、型別、選項、必填與排序",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 md:grid-cols-2">
          {/* 左:現有欄位清單 */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">
              {t("fields.settings.existing", { defaultValue: "現有欄位" })}
            </p>
            {listQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : fields.length === 0 ? (
              <p className="rounded-md border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                {t("fields.settings.empty", { defaultValue: "尚未建立自訂欄位" })}
              </p>
            ) : (
              <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
                {fields.map((f) => (
                  <li
                    key={f.id}
                    className={`flex items-center justify-between gap-2 rounded-md border p-2 text-sm ${
                      editing?.id === f.id ? "border-primary bg-accent" : "border-border"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{f.label}</span>
                        {f.required && (
                          <Badge variant="destructive" className="shrink-0">
                            {t("fields.form.required", { defaultValue: "必填" })}
                          </Badge>
                        )}
                      </div>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {f.key} · {t(`fields.type.${f.field_type}`, { defaultValue: f.field_type })}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => startEdit(f)}
                        title={t("fields.actions.edit", { defaultValue: "編輯" })}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        disabled={deleteMut.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              t("fields.deleteConfirm", {
                                defaultValue:
                                  "確定刪除此自訂欄位?已填入的值將不再顯示,但仍保留於既有工單資料中。",
                              }),
                            )
                          )
                            deleteMut.mutate(f.id);
                        }}
                        title={t("fields.actions.delete", { defaultValue: "刪除" })}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 右:新增 / 編輯表單 */}
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-muted-foreground">
                {editing
                  ? t("fields.settings.editTitle", { defaultValue: "編輯欄位" })
                  : t("fields.settings.addTitle", { defaultValue: "新增欄位" })}
              </p>
              {editing && (
                <Button variant="ghost" size="sm" className="h-6 px-2" onClick={resetForm}>
                  <X className="h-3.5 w-3.5" /> {t("fields.form.cancel", { defaultValue: "取消" })}
                </Button>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fd-label">{t("fields.form.label", { defaultValue: "顯示名稱" })}</Label>
              <Input
                id="fd-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("fields.form.labelPlaceholder", { defaultValue: "例:訂單編號" })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fd-key">{t("fields.form.key", { defaultValue: "欄位鍵(Key)" })}</Label>
              <Input
                id="fd-key"
                value={key}
                disabled={!!editing}
                onChange={(e) => setKey(e.target.value)}
                placeholder={t("fields.form.keyPlaceholder", { defaultValue: "例:order_no" })}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {t("fields.form.keyHint", {
                  defaultValue: "英數與底線,需英文開頭;建立後不可變更",
                })}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="fd-type">{t("fields.form.type", { defaultValue: "型別" })}</Label>
                <select
                  id="fd-type"
                  className={SELECT_CLS}
                  value={fieldType}
                  onChange={(e) => setFieldType(e.target.value as FieldType)}
                >
                  {FIELD_TYPES.map((ft) => (
                    <option key={ft} value={ft}>
                      {t(`fields.type.${ft}`, { defaultValue: ft })}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fd-sort">{t("fields.form.sortOrder", { defaultValue: "排序(小的在前)" })}</Label>
                <Input
                  id="fd-sort"
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
                />
              </div>
            </div>

            {fieldType === "select" && (
              <div className="space-y-1.5">
                <Label htmlFor="fd-options">{t("fields.form.options", { defaultValue: "選項" })}</Label>
                <Textarea
                  id="fd-options"
                  value={optionsText}
                  onChange={(e) => setOptionsText(e.target.value)}
                  placeholder={t("fields.form.optionsHint", {
                    defaultValue: "每行一個選項(僅「下拉選單」型別需要)",
                  })}
                  rows={4}
                />
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              {t("fields.form.required", { defaultValue: "必填" })}
            </label>

            {formError && <p className="text-sm text-destructive">{formError}</p>}

            <div className="flex justify-end gap-2 pt-1">
              {!editing && (
                <Button variant="ghost" onClick={resetForm} disabled={saveMut.isPending}>
                  {t("fields.form.reset", { defaultValue: "清空" })}
                </Button>
              )}
              <Button onClick={submit} disabled={saveMut.isPending}>
                {editing ? (
                  saveMut.isPending ? (
                    t("fields.form.updating", { defaultValue: "更新中…" })
                  ) : (
                    t("fields.form.update", { defaultValue: "更新" })
                  )
                ) : saveMut.isPending ? (
                  t("fields.form.creating", { defaultValue: "新增中…" })
                ) : (
                  <>
                    <Plus className="h-4 w-4" /> {t("fields.form.create", { defaultValue: "新增欄位" })}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ======================= 自訂欄位輸入(建立 / 詳情共用) ======================= */
/** 依 FieldDefinition 動態渲染輸入,值讀寫於 attributes(key → 值)。 */
export function CustomFieldInputs({
  fields,
  values,
  onChange,
  idPrefix = "cf",
}: {
  fields: FieldDefinition[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  idPrefix?: string;
}) {
  const { t } = useTranslation();
  if (fields.length === 0) return null;

  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <p className="text-xs font-semibold text-muted-foreground">
        {t("fields.section.custom", { defaultValue: "自訂欄位" })}
      </p>
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const raw = values[f.key];
        const labelNode = (
          <Label htmlFor={id}>
            {f.label}
            {f.required && <span className="ml-1 text-destructive">*</span>}
          </Label>
        );

        if (f.field_type === "checkbox") {
          return (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <input
                id={id}
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={raw === true}
                onChange={(e) => set(f.key, e.target.checked)}
              />
              {f.label}
              {f.required && <span className="text-destructive">*</span>}
            </label>
          );
        }

        if (f.field_type === "textarea") {
          return (
            <div key={f.key} className="space-y-1.5">
              {labelNode}
              <Textarea
                id={id}
                value={typeof raw === "string" ? raw : ""}
                onChange={(e) => set(f.key, e.target.value)}
              />
            </div>
          );
        }

        if (f.field_type === "select") {
          return (
            <div key={f.key} className="space-y-1.5">
              {labelNode}
              <select
                id={id}
                className={SELECT_CLS}
                value={typeof raw === "string" ? raw : ""}
                onChange={(e) => set(f.key, e.target.value)}
              >
                <option value="">{t("fields.selectPlaceholder", { defaultValue: "請選擇" })}</option>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        // text / url / number / date → <Input>
        const inputType =
          f.field_type === "number" ? "number" : f.field_type === "date" ? "date" : f.field_type === "url" ? "url" : "text";
        return (
          <div key={f.key} className="space-y-1.5">
            {labelNode}
            <Input
              id={id}
              type={inputType}
              value={raw == null ? "" : String(raw)}
              onChange={(e) => {
                const v = e.target.value;
                set(f.key, f.field_type === "number" ? (v === "" ? "" : Number(v)) : v);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
