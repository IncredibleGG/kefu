import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Ban, ShieldCheck, Tag as TagIcon, Clock, Mail, Phone, Building2, Plus, Trash2, Upload, Download, FileSpreadsheet, CheckCircle2, AlertCircle } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { visitorApi } from "@/api/endpoints";
import {
  useContacts,
  useContactDetail,
  useVisitorTimeline,
  useCrmMutations,
  useTags,
} from "@/api/hooks";
import { channelMeta } from "@/lib/channels";
import { downloadFile } from "@/lib/download";
import { saveFile } from "@/lib/platform";
import { initials, timeAgo, hhmm } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
  importContactsCsv,
  CONTACT_IMPORT_TEMPLATE,
  type ContactImportResult,
  type OnDuplicate,
} from "@/api/contactImport";
import type { Visitor, VisitorTimeline } from "@/types";

type View = "visitors" | "contacts" | "tags";

/** 自訂屬性可編輯列(聯絡人檔案 attributes 的 key-value 呈現)。 */
type AttrRow = { k: string; v: string };

/** 後端 attributes(自由 key-value)→ 可編輯列;值一律轉字串,物件/陣列以 JSON 呈現。 */
function attrsToRows(attributes?: Record<string, unknown> | null): AttrRow[] {
  return Object.entries(attributes ?? {}).map(([k, val]) => ({
    k,
    v:
      val === null || val === undefined
        ? ""
        : typeof val === "string"
          ? val
          : typeof val === "object"
            ? JSON.stringify(val)
            : String(val),
  }));
}

/** 可編輯列 → 送後端的 attributes 物件:trim key、略過空 key、同名後者覆蓋前者。 */
function rowsToAttributes(rows: AttrRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { k, v } of rows) {
    const key = k.trim();
    if (!key) continue;
    out[key] = v;
  }
  return out;
}

/** 訪客 / 客戶(CRM)管理:列出訪客與聯絡人,搜尋 / 依標籤篩選,開啟 CRM 檔案,可加黑名單。 */
export function VisitorsPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const tabParam = params.get("tab");
  const view: View = tabParam === "contacts" ? "contacts" : tabParam === "tags" ? "tags" : "visitors";

  const [q, setQ] = useState("");
  const [tagId, setTagId] = useState<string>("");
  const { data: tags } = useTags();
  const tagMap = useMemo(
    () => new Map((tags ?? []).map((t) => [t.id, t] as const)),
    [tags],
  );

  const [openVisitor, setOpenVisitor] = useState<string | null>(null);
  const [openContact, setOpenContact] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const title =
    view === "contacts"
      ? t("modules.visitors.titleContacts")
      : view === "tags"
        ? t("modules.visitors.titleTags")
        : t("modules.visitors.titleVisitors");
  const desc =
    view === "contacts"
      ? t("modules.visitors.descContacts")
      : view === "tags"
        ? t("modules.visitors.descTags")
        : t("modules.visitors.descVisitors");

  return (
    <PageShell title={title} description={desc}>
      {/* 篩選列(手機:搜尋獨佔一列;標籤改成單列橫向捲動,不疊成好幾行) */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-64 max-w-full max-md:w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("modules.visitors.searchPlaceholder")}
            className="h-8 pl-8 max-md:h-9"
          />
        </div>
        {(tags ?? []).length > 0 && (
          <div className="flex flex-wrap items-center gap-1 max-md:w-full max-md:flex-nowrap max-md:overflow-x-auto max-md:scrollbar-none">
            <TagIcon className="h-3.5 w-3.5 text-muted-foreground max-md:shrink-0" />
            <button
              onClick={() => setTagId("")}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs transition-colors max-md:shrink-0 pointer-coarse:min-h-10 pointer-coarse:px-3",
                tagId === ""
                  ? "border-brand bg-brand/10 text-brand"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {t("modules.visitors.allTags")}
            </button>
            {(tags ?? []).map((tg) => (
              <button
                key={tg.id}
                onClick={() => setTagId(tg.id)}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-xs transition-colors max-md:shrink-0 pointer-coarse:min-h-10 pointer-coarse:px-3",
                  tagId === tg.id
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                {tg.name}
              </button>
            ))}
          </div>
        )}
        {view === "contacts" && (
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={() => downloadFile("/api/v1/exports/contacts.csv", "contacts.csv").catch(() => {})}
            >
              <Download className="h-4 w-4" /> {t("common.exportCsv", { defaultValue: "匯出 CSV" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={() => setImportOpen(true)}
            >
              <Upload className="h-4 w-4" /> {t("import.button", { defaultValue: "匯入" })}
            </Button>
          </div>
        )}
      </div>

      {view === "tags" && !tagId && (tags ?? []).length > 0 && (
        <p className="mb-2 text-xs text-muted-foreground">{t("modules.visitors.pickTagHint")}</p>
      )}

      {view === "contacts" ? (
        <ContactsTable q={q} tagId={tagId || undefined} onOpen={setOpenContact} />
      ) : (
        <VisitorsTable q={q} tagId={tagId || undefined} onOpen={setOpenVisitor} tagMap={tagMap} />
      )}

      {view === "tags" && (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-semibold text-muted-foreground">{t("modules.visitors.contactsUnderTag")}</h3>
          <ContactsTable q={q} tagId={tagId || undefined} onOpen={setOpenContact} />
        </div>
      )}

      <VisitorDetailDialog
        visitorId={openVisitor}
        onClose={() => setOpenVisitor(null)}
        tagMap={tagMap}
      />
      <ContactDetailDialog
        contactId={openContact}
        onClose={() => setOpenContact(null)}
        tagMap={tagMap}
      />
      <ImportContactsDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </PageShell>
  );
}

/* ----------------------- 聯絡人批量匯入(CSV)----------------------- */
function ImportContactsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [onDup, setOnDup] = useState<OnDuplicate>("update");
  const [result, setResult] = useState<ContactImportResult | null>(null);

  const importMutation = useMutation({
    mutationFn: () => importContactsCsv(file!, onDup),
    onSuccess: (res) => {
      setResult(res);
      // 匯入後失效聯絡人清單快取,清單重新抓取
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });

  function resetState() {
    setFile(null);
    setResult(null);
    importMutation.reset();
  }

  function downloadTemplate() {
    // 前端產生 Blob 觸發下載(使用者自行取得範本,不涉及外部來源)
    const blob = new Blob(["﻿" + CONTACT_IMPORT_TEMPLATE], {
      type: "text/csv;charset=utf-8",
    });
    // 交給平台層存檔(web:<a download>;桌面:存檔對話框;手機:分享面板)
    void saveFile(blob, "contacts-template.csv").catch(() => undefined);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          resetState();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("import.title", { defaultValue: "批量匯入聯絡人" })}</DialogTitle>
          <DialogDescription>
            {t("import.desc", { defaultValue: "上傳 CSV 檔案批量建立聯絡人。" })}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          /* ---------- 匯入結果 ---------- */
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-brand">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-medium">{t("import.done", { defaultValue: "匯入完成" })}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border border-border p-3 text-center">
                <p className="text-lg font-semibold">{result.created}</p>
                <p className="text-xs text-muted-foreground">{t("import.created", { defaultValue: "新建" })}</p>
              </div>
              <div className="rounded-md border border-border p-3 text-center">
                <p className="text-lg font-semibold">{result.updated}</p>
                <p className="text-xs text-muted-foreground">{t("import.updated", { defaultValue: "更新" })}</p>
              </div>
              <div className="rounded-md border border-border p-3 text-center">
                <p className="text-lg font-semibold">{result.skipped}</p>
                <p className="text-xs text-muted-foreground">{t("import.skipped", { defaultValue: "略過" })}</p>
              </div>
            </div>
            <div>
              <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                <AlertCircle className="h-3.5 w-3.5" />
                {t("import.errorsTitle", { defaultValue: "錯誤列" })} ({result.errors.length})
              </p>
              {result.errors.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("import.noErrors", { defaultValue: "沒有錯誤列" })}
                </p>
              ) : (
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {result.errors.map((e, i) => (
                    <div
                      key={i}
                      className="flex items-start justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
                    >
                      <span className="shrink-0 font-mono text-muted-foreground">
                        {t("import.errorRow", { row: e.row, defaultValue: "第 {{row}} 列" })}
                      </span>
                      <span className="text-right text-destructive">{e.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ---------- 上傳表單 ---------- */
          <div className="space-y-3 text-sm">
            {/* 欄位對映說明 + 範本下載 */}
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground">
                  {t("import.fieldMapping", { defaultValue: "欄位對映" })}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={downloadTemplate}
                >
                  <Download className="h-3.5 w-3.5" />
                  {t("import.downloadTemplate", { defaultValue: "下載 CSV 範本" })}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("import.fieldMappingDesc", {
                  defaultValue:
                    "支援欄位:name(姓名)、email、phone(電話)、company(公司),其餘欄位會存入自訂屬性。第一列必須為表頭。",
                })}
              </p>
            </div>

            {/* 選檔 */}
            <div className="space-y-1.5">
              <Label htmlFor="import-file">{t("import.selectFile", { defaultValue: "選擇 CSV 檔案" })}</Label>
              <label
                htmlFor="import-file"
                className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm hover:bg-accent"
              >
                <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                <span className={cn(file ? "font-medium" : "text-muted-foreground")}>
                  {file ? file.name : t("import.noFile", { defaultValue: "尚未選擇檔案" })}
                </span>
              </label>
              <input
                id="import-file"
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>

            {/* 重複策略 */}
            <div className="space-y-1.5">
              <Label>{t("import.onDuplicate", { defaultValue: "遇到重複(相同 email 或電話)時" })}</Label>
              <div className="flex gap-1.5">
                {(["update", "skip"] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setOnDup(opt)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs transition-colors",
                      onDup === opt
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {opt === "update"
                      ? t("import.dupUpdate", { defaultValue: "更新既有聯絡人" })
                      : t("import.dupSkip", { defaultValue: "略過" })}
                  </button>
                ))}
              </div>
            </div>

            {importMutation.isError && (
              <p className="text-xs text-destructive">
                {t("import.failed", { defaultValue: "匯入失敗,請確認檔案格式與內容。" })}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <>
              <Button variant="outline" onClick={resetState}>
                {t("import.importAnother", { defaultValue: "再匯入一批" })}
              </Button>
              <Button
                onClick={() => {
                  resetState();
                  onClose();
                }}
              >
                {t("import.close", { defaultValue: "關閉" })}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  resetState();
                  onClose();
                }}
              >
                {t("import.cancel", { defaultValue: "取消" })}
              </Button>
              <Button
                onClick={() => importMutation.mutate()}
                disabled={!file || importMutation.isPending}
              >
                {importMutation.isPending
                  ? t("import.importing", { defaultValue: "匯入中…" })
                  : t("import.submit", { defaultValue: "開始匯入" })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type TagMap = Map<string, { id: string; name: string; color: string | null; category: string | null }>;

/* ------------------------------- 訪客表 ------------------------------- */
function VisitorsTable({
  q,
  tagId,
  onOpen,
  tagMap,
}: {
  q: string;
  tagId?: string;
  onOpen: (id: string) => void;
  tagMap: TagMap;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ["visitors", q, tagId ?? ""],
    queryFn: () => visitorApi.list({ q: q || undefined, tag_id: tagId }),
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  const rows = data ?? [];
  return (
    <>
      {/* 手機(< md):卡片列表 */}
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border md:hidden">
        {rows.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">{t("modules.visitors.noData")}</li>
        )}
        {rows.map((v) => {
          const m = channelMeta[v.channel];
          return (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => onOpen(v.id)}
                className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-accent active:bg-accent"
              >
                <Avatar className="h-9 w-9 shrink-0">
                  <AvatarFallback>{initials(v.display_name)}</AvatarFallback>
                </Avatar>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{v.display_name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {v.first_seen ? timeAgo(v.first_seen) : "—"}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <m.Icon className={`h-3.5 w-3.5 ${m.color}`} />
                      {m.label}
                    </span>
                    {v.location && <span className="min-w-0 truncate">{v.location}</span>}
                    {v.tags.map((tid) => (
                      <Badge key={tid} variant="secondary">
                        {tagMap.get(tid)?.name ?? tid}
                      </Badge>
                    ))}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="overflow-hidden rounded-lg border border-border max-md:hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">{t("modules.visitors.colVisitor")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("modules.visitors.colChannel")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("modules.visitors.colRegion")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("modules.visitors.tags")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("modules.visitors.colFirstSeen")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  {t("modules.visitors.noData")}
                </td>
              </tr>
            )}
            {rows.map((v) => {
              const m = channelMeta[v.channel];
              return (
                <tr
                  key={v.id}
                  onClick={() => onOpen(v.id)}
                  className="cursor-pointer hover:bg-accent"
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Avatar className="h-7 w-7">
                        <AvatarFallback>{initials(v.display_name)}</AvatarFallback>
                      </Avatar>
                      <span className="font-medium">{v.display_name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1">
                      <m.Icon className={`h-4 w-4 ${m.color}`} />
                      {m.label}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{v.location ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {v.tags.length ? (
                        v.tags.map((tid) => (
                          <Badge key={tid} variant="secondary">
                            {tagMap.get(tid)?.name ?? tid}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {v.first_seen ? timeAgo(v.first_seen) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ------------------------------ 聯絡人表 ------------------------------ */
function ContactsTable({
  q,
  tagId,
  onOpen,
}: {
  q: string;
  tagId?: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useContacts(q || undefined, tagId);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  const rows = data ?? [];
  return (
    <>
      {/* 手機(< md):卡片列表 */}
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border md:hidden">
        {rows.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">{t("modules.visitors.noData")}</li>
        )}
        {rows.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onOpen(c.id)}
              className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-accent active:bg-accent"
            >
              <Avatar className="h-9 w-9 shrink-0">
                <AvatarFallback>{initials(c.name)}</AvatarFallback>
              </Avatar>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium">{c.name}</span>
                {(c.email || c.phone) && (
                  <span className="truncate text-xs text-muted-foreground">
                    {[c.email, c.phone].filter(Boolean).join(" · ")}
                  </span>
                )}
                {c.company && (
                  <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <Building2 className="h-3 w-3 shrink-0" />
                    <span className="truncate">{c.company}</span>
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="overflow-hidden rounded-lg border border-border max-md:hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">{t("modules.visitors.colContact")}</th>
              <th className="px-4 py-2.5 text-left font-medium">Email</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("modules.visitors.phone")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("modules.visitors.company")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                  {t("modules.visitors.noData")}
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id} onClick={() => onOpen(c.id)} className="cursor-pointer hover:bg-accent">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Avatar className="h-7 w-7">
                      <AvatarFallback>{initials(c.name)}</AvatarFallback>
                    </Avatar>
                    <span className="font-medium">{c.name}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{c.email ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{c.phone ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{c.company ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* --------------------------- 訪客 CRM 檔案 --------------------------- */
function VisitorDetailDialog({
  visitorId,
  onClose,
  tagMap,
}: {
  visitorId: string | null;
  onClose: () => void;
  tagMap: TagMap;
}) {
  const { t } = useTranslation();
  const { data: visitor, isLoading } = useQuery({
    queryKey: ["visitor", visitorId ?? "none"],
    queryFn: () => visitorApi.get(visitorId!),
    enabled: !!visitorId,
  });
  const { data: timeline } = useVisitorTimeline(visitorId ?? undefined);
  const { blockVisitor, unblockVisitor } = useCrmMutations();

  return (
    <Dialog open={!!visitorId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("modules.visitors.visitorProfile")}</DialogTitle>
          <DialogDescription>{t("modules.visitors.visitorProfileDesc")}</DialogDescription>
        </DialogHeader>

        {isLoading || !visitor ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <VisitorBody visitor={visitor} tagMap={tagMap} timeline={timeline} />
        )}

        <DialogFooter>
          {/* 依封鎖狀態二選一(對齊聯絡人檔案):已封鎖顯示「解除封鎖」,否則顯示「加入黑名單」。
              Visitor 型別未含 is_blocked,實際回應由 mapVisitor 帶出,故就地取值。 */}
          {visitor &&
            ((visitor as { is_blocked?: boolean }).is_blocked ? (
              <Button
                variant="ghost"
                onClick={() => unblockVisitor.mutate(visitor.id)}
                disabled={unblockVisitor.isPending}
              >
                <ShieldCheck className="h-4 w-4" /> {t("modules.visitors.unblock")}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => blockVisitor.mutate(visitor.id)}
                disabled={blockVisitor.isPending}
              >
                <Ban className="h-4 w-4" /> {t("modules.visitors.addToBlocklist")}
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VisitorBody({
  visitor,
  tagMap,
  timeline,
}: {
  visitor: Visitor;
  tagMap: TagMap;
  timeline?: VisitorTimeline;
}) {
  const { t } = useTranslation();
  const m = channelMeta[visitor.channel];
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-3">
        <Avatar className="h-10 w-10">
          <AvatarFallback>{initials(visitor.display_name)}</AvatarFallback>
        </Avatar>
        <div>
          <p className="font-medium">{visitor.display_name}</p>
          <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <m.Icon className={`h-3.5 w-3.5 ${m.color}`} /> {m.label}
            {visitor.external_id ? ` · ${visitor.external_id}` : ""}
          </p>
        </div>
      </div>

      {visitor.contact && (
        <div className="rounded-md border border-border p-3">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">{t("modules.visitors.linkedContact")}</p>
          <p>{visitor.contact.name}</p>
          {visitor.contact.email && <p className="text-xs text-muted-foreground">{visitor.contact.email}</p>}
        </div>
      )}

      <div>
        <p className="mb-1 text-xs font-semibold text-muted-foreground">{t("modules.visitors.tags")}</p>
        <div className="flex flex-wrap gap-1">
          {visitor.tags.length ? (
            visitor.tags.map((tid) => (
              <Badge key={tid} variant="secondary">
                {tagMap.get(tid)?.name ?? tid}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">{t("modules.visitors.none")}</span>
          )}
        </div>
      </div>

      <div>
        <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
          <Clock className="h-3.5 w-3.5" /> {t("modules.visitors.sessionHistory")}
        </p>
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {(timeline?.sessions ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("modules.visitors.noSessions")}</p>
          ) : (
            (timeline?.sessions ?? []).map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs"
              >
                <span className="font-mono text-muted-foreground">{s.id.slice(0, 8)}</span>
                <span>
                  {s.status} · {s.handler_type}
                </span>
                <span className="text-muted-foreground">
                  {s.created_at ? hhmm(s.created_at) : "—"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------- 聯絡人 CRM 檔案 -------------------------- */
function ContactDetailDialog({
  contactId,
  onClose,
  tagMap,
}: {
  contactId: string | null;
  onClose: () => void;
  tagMap: TagMap;
}) {
  const { t } = useTranslation();
  const { data: contact, isLoading } = useContactDetail(contactId ?? undefined);
  const { updateContact, blockContact, unblockContact } = useCrmMutations();

  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [attrRows, setAttrRows] = useState<AttrRow[]>([]);
  const [initId, setInitId] = useState<string | null>(null);

  // 載入聯絡人 → 帶入可編輯欄位(以 id 變更為準,避免每次 render 重設)
  if (contact && contact.id !== initId) {
    setInitId(contact.id);
    setName(contact.name ?? "");
    setEmail(contact.email ?? "");
    setPhone(contact.phone ?? "");
    setNote(contact.note ?? "");
    setAttrRows(attrsToRows(contact.attributes));
  }

  async function saveFields() {
    if (!contact) return;
    await updateContact.mutateAsync({
      id: contact.id,
      body: {
        name,
        email: email || null,
        phone: phone || null,
        note: note || null,
        // 全量送出:後端整體覆蓋 attributes,故新增/編輯/刪除皆以此列表為準
        attributes: rowsToAttributes(attrRows),
      },
    });
  }

  return (
    <Dialog
      open={!!contactId}
      onOpenChange={(v) => {
        if (!v) {
          setInitId(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("modules.visitors.titleContacts")}</DialogTitle>
          <DialogDescription>{t("modules.visitors.contactProfileDesc")}</DialogDescription>
        </DialogHeader>

        {isLoading || !contact ? (
          <Skeleton className="h-56 w-full" />
        ) : (
          <div className="space-y-3 text-sm">
            {contact.is_blocked && (
              <Badge variant="destructive" className="gap-1">
                <Ban className="h-3 w-3" /> {t("modules.visitors.blocked")}
              </Badge>
            )}
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <div className="space-y-1.5">
                <Label htmlFor="ct-name">{t("modules.visitors.name")}</Label>
                <Input id="ct-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ct-phone" className="flex items-center gap-1">
                  <Phone className="h-3.5 w-3.5" /> {t("modules.visitors.phone")}
                </Label>
                <Input id="ct-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-email" className="flex items-center gap-1">
                <Mail className="h-3.5 w-3.5" /> Email
              </Label>
              <Input id="ct-email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {contact.company && (
              <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" /> {contact.company}
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="ct-note">{t("modules.visitors.note")}</Label>
              <Textarea
                id="ct-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("modules.visitors.notePlaceholder")}
              />
            </div>

            {/* 自訂屬性(CRM attributes):可新增 / 編輯 / 刪除 key-value 列 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>{t("workspace.contextPanel.customAttributes")}</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => setAttrRows((r) => [...r, { k: "", v: "" }])}
                >
                  <Plus className="h-3.5 w-3.5" /> {t("contact.addField", { defaultValue: "新增欄位" })}
                </Button>
              </div>
              {attrRows.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("contact.noCustom", { defaultValue: "尚無自訂欄位" })}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {attrRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Input
                        value={row.k}
                        onChange={(e) =>
                          setAttrRows((rows) =>
                            rows.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)),
                          )
                        }
                        placeholder={t("contact.keyPlaceholder", { defaultValue: "欄位名稱" })}
                        className="h-8 flex-1"
                      />
                      <Input
                        value={row.v}
                        onChange={(e) =>
                          setAttrRows((rows) =>
                            rows.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)),
                          )
                        }
                        placeholder={t("contact.valuePlaceholder", { defaultValue: "值" })}
                        className="h-8 flex-1"
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        title={t("contact.removeField", { defaultValue: "刪除欄位" })}
                        onClick={() => setAttrRows((rows) => rows.filter((_, j) => j !== i))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">{t("modules.visitors.tags")}</p>
              <div className="flex flex-wrap gap-1">
                {contact.tags.length ? (
                  contact.tags.map((tid) => (
                    <Badge key={tid} variant="secondary">
                      {tagMap.get(tid)?.name ?? tid}
                    </Badge>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">{t("modules.visitors.none")}</span>
                )}
              </div>
            </div>

            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">{t("modules.visitors.linkedVisitors")}</p>
              <div className="space-y-1">
                {contact.visitors.length === 0 ? (
                  <span className="text-xs text-muted-foreground">{t("modules.visitors.none")}</span>
                ) : (
                  contact.visitors.map((v) => (
                    <div
                      key={v.id}
                      className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs"
                    >
                      <span>{v.display_name}</span>
                      {v.is_blocked && <Badge variant="destructive">{t("modules.visitors.blockedShort")}</Badge>}
                    </div>
                  ))
                )}
              </div>
            </div>

            {updateContact.isError && (
              <p className="text-xs text-destructive">{t("common.error")}</p>
            )}
          </div>
        )}

        <DialogFooter className="flex-wrap justify-between gap-2">
          <div className="flex gap-2">
            {contact &&
              (contact.is_blocked ? (
                <Button
                  variant="ghost"
                  onClick={() => unblockContact.mutate(contact.id)}
                  disabled={unblockContact.isPending}
                >
                  <ShieldCheck className="h-4 w-4" /> {t("modules.visitors.unblock")}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => blockContact.mutate(contact.id)}
                  disabled={blockContact.isPending}
                >
                  <Ban className="h-4 w-4" /> {t("modules.visitors.addToBlocklist")}
                </Button>
              ))}
          </div>
          <Button onClick={saveFields} disabled={!contact || updateContact.isPending}>
            {updateContact.isPending ? t("modules.visitors.saving") : t("modules.visitors.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
