import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Plus,
  Trash2,
  Pencil,
  Globe,
  Building2,
  Users,
  ChevronLeft,
  ChevronRight,
  UserPlus,
  X,
  AlertCircle,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, timeAgo } from "@/lib/utils";
import {
  companyApi,
  type Company,
  type CompanyContact,
  type CompanyInput,
} from "@/api/company";

const PAGE_SIZE = 20;

/** 公司(B2B CRM)管理:列出公司、搜尋 / 分頁、建立 / 編輯 / 刪除,
 *  並在公司詳情中檢視與增減其聯絡人歸屬。 */
export function CompanyPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // 搜尋字變動時回到第一頁
  useEffect(() => {
    setOffset(0);
  }, [q]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["companies", q, offset],
    queryFn: () => companyApi.list({ q: q || undefined, limit: PAGE_SIZE, offset }),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <PageShell
      title={t("company.title", { defaultValue: "公司" })}
      description={t("company.desc", { defaultValue: "B2B 客戶公司主檔:管理公司資料與其所屬聯絡人" })}
      actions={
        <Button size="sm" className="h-8 gap-1" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> {t("company.new", { defaultValue: "新增公司" })}
        </Button>
      }
    >
      {/* 搜尋列 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-72 max-w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("company.searchPlaceholder", { defaultValue: "搜尋公司名稱 / 網域…" })}
            className="h-8 pl-8"
          />
        </div>
      </div>

      {isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-6 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {t("company.loadError", { defaultValue: "載入公司清單失敗,請稍後再試。" })}
        </div>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t("company.colName", { defaultValue: "公司" })}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t("company.colDomain", { defaultValue: "網域" })}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t("company.colIndustry", { defaultValue: "產業" })}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t("company.colSize", { defaultValue: "規模" })}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t("company.colCreated", { defaultValue: "建立時間" })}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                      {q
                        ? t("company.noMatch", { defaultValue: "沒有符合搜尋的公司" })
                        : t("company.empty", { defaultValue: "尚無公司,點右上角「新增公司」開始建立。" })}
                    </td>
                  </tr>
                )}
                {items.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setOpenId(c.id)}
                    className="cursor-pointer hover:bg-accent"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          <Building2 className="h-4 w-4" />
                        </div>
                        <span className="font-medium">{c.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {c.domain ? (
                        <span className="inline-flex items-center gap-1">
                          <Globe className="h-3.5 w-3.5" /> {c.domain}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{c.industry || "—"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{c.size || "—"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {c.created_at ? timeAgo(c.created_at) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 分頁 */}
          {total > 0 && (
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {t("company.pageInfo", {
                  from,
                  to,
                  total,
                  defaultValue: "{{from}}–{{to}} / 共 {{total}} 家",
                })}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={offset === 0}
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  aria-label={t("company.prevPage", { defaultValue: "上一頁" })}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={to >= total}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  aria-label={t("company.nextPage", { defaultValue: "下一頁" })}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <CompanyFormDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <CompanyDetailDialog companyId={openId} onClose={() => setOpenId(null)} />
    </PageShell>
  );
}

/* ----------------------- 建立 / 編輯 公司表單 ----------------------- */
function CompanyFormDialog({
  open,
  onClose,
  company,
}: {
  open: boolean;
  onClose: () => void;
  company?: Company;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isEdit = !!company;

  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [industry, setIndustry] = useState("");
  const [size, setSize] = useState("");
  const [notes, setNotes] = useState("");

  // 開啟(或切換編輯對象)時帶入初值
  useEffect(() => {
    if (open) {
      setName(company?.name ?? "");
      setDomain(company?.domain ?? "");
      setIndustry(company?.industry ?? "");
      setSize(company?.size ?? "");
      setNotes(company?.notes ?? "");
    }
  }, [open, company]);

  const mutation = useMutation({
    mutationFn: () => {
      const body: CompanyInput = {
        name: name.trim(),
        domain: domain.trim() || null,
        industry: industry.trim() || null,
        size: size.trim() || null,
        notes: notes.trim() || null,
      };
      return isEdit
        ? companyApi.update(company!.id, body)
        : companyApi.create({ ...body, name: name.trim() });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      if (isEdit) qc.invalidateQueries({ queryKey: ["company", company!.id] });
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("company.editTitle", { defaultValue: "編輯公司" })
              : t("company.newTitle", { defaultValue: "新增公司" })}
          </DialogTitle>
          <DialogDescription>
            {t("company.formDesc", { defaultValue: "公司主檔資料;名稱為必填。" })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="space-y-1.5">
            <Label htmlFor="co-name">
              {t("company.name", { defaultValue: "公司名稱" })}
              <span className="ml-0.5 text-destructive">*</span>
            </Label>
            <Input
              id="co-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("company.namePlaceholder", { defaultValue: "例:Acme 科技" })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="co-domain" className="flex items-center gap-1">
                <Globe className="h-3.5 w-3.5" /> {t("company.domain", { defaultValue: "網域" })}
              </Label>
              <Input
                id="co-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="acme.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="co-industry">{t("company.industry", { defaultValue: "產業" })}</Label>
              <Input
                id="co-industry"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder={t("company.industryPlaceholder", { defaultValue: "例:SaaS" })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="co-size">{t("company.size", { defaultValue: "規模" })}</Label>
            <Input
              id="co-size"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              placeholder={t("company.sizePlaceholder", { defaultValue: "例:51-200 人" })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="co-notes">{t("company.notes", { defaultValue: "備註" })}</Label>
            <Textarea
              id="co-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("company.notesPlaceholder", { defaultValue: "內部備註…" })}
            />
          </div>

          {mutation.isError && (
            <p className="text-xs text-destructive">
              {t("company.saveError", { defaultValue: "儲存失敗,請確認欄位後再試。" })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("company.cancel", { defaultValue: "取消" })}
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!name.trim() || mutation.isPending}>
            {mutation.isPending
              ? t("company.saving", { defaultValue: "儲存中…" })
              : t("company.save", { defaultValue: "儲存" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------- 公司詳情 --------------------------- */
function CompanyDetailDialog({
  companyId,
  onClose,
}: {
  companyId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: company, isLoading } = useQuery({
    queryKey: ["company", companyId ?? "none"],
    queryFn: () => companyApi.get(companyId!),
    enabled: !!companyId,
  });

  const { data: contacts, isLoading: contactsLoading } = useQuery({
    queryKey: ["company-contacts", companyId ?? "none"],
    queryFn: () => companyApi.contacts(companyId!),
    enabled: !!companyId,
  });

  const removeCompany = useMutation({
    mutationFn: () => companyApi.remove(companyId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      onClose();
    },
  });

  const unassign = useMutation({
    mutationFn: (contactId: string) => companyApi.unassignContact(companyId!, contactId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-contacts", companyId] });
      qc.invalidateQueries({ queryKey: ["company", companyId] });
    },
  });

  // 對話框關閉時重置就地狀態
  useEffect(() => {
    if (!companyId) {
      setEditOpen(false);
      setConfirmDelete(false);
    }
  }, [companyId]);

  return (
    <>
      <Dialog open={!!companyId && !editOpen} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              {company?.name ?? t("company.detailTitle", { defaultValue: "公司詳情" })}
            </DialogTitle>
            <DialogDescription>
              {t("company.detailDesc", { defaultValue: "公司資料與所屬聯絡人。" })}
            </DialogDescription>
          </DialogHeader>

          {isLoading || !company ? (
            <Skeleton className="h-56 w-full" />
          ) : (
            <div className="space-y-3 text-sm">
              {/* 基本資料 */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border p-3">
                <Field label={t("company.domain", { defaultValue: "網域" })} value={company.domain} />
                <Field label={t("company.industry", { defaultValue: "產業" })} value={company.industry} />
                <Field label={t("company.size", { defaultValue: "規模" })} value={company.size} />
                <Field
                  label={t("company.colCreated", { defaultValue: "建立時間" })}
                  value={company.created_at ? timeAgo(company.created_at) : null}
                />
              </div>
              {company.notes && (
                <div className="rounded-md border border-border p-3">
                  <p className="mb-1 text-xs font-semibold text-muted-foreground">
                    {t("company.notes", { defaultValue: "備註" })}
                  </p>
                  <p className="whitespace-pre-wrap">{company.notes}</p>
                </div>
              )}

              {/* 聯絡人 */}
              <div>
                <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                  <Users className="h-3.5 w-3.5" />
                  {t("company.contacts", { defaultValue: "所屬聯絡人" })}
                  <Badge variant="secondary" className="ml-1">
                    {company.contact_count}
                  </Badge>
                </p>
                {contactsLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : (contacts ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("company.noContacts", { defaultValue: "此公司尚無聯絡人,於下方搜尋加入。" })}
                  </p>
                ) : (
                  <div className="max-h-48 space-y-1 overflow-y-auto">
                    {(contacts ?? []).map((ct) => (
                      <ContactRow
                        key={ct.id}
                        contact={ct}
                        onRemove={() => unassign.mutate(ct.id)}
                        removing={unassign.isPending && unassign.variables === ct.id}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* 加入聯絡人 */}
              {companyId && <AddContactSearch companyId={companyId} />}

              {removeCompany.isError && (
                <p className="text-xs text-destructive">
                  {t("company.deleteError", { defaultValue: "刪除失敗,請稍後再試。" })}
                </p>
              )}
            </div>
          )}

          <DialogFooter className="flex-wrap justify-between gap-2">
            <div className="flex gap-2">
              {confirmDelete ? (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => removeCompany.mutate()}
                    disabled={removeCompany.isPending}
                  >
                    {removeCompany.isPending
                      ? t("company.deleting", { defaultValue: "刪除中…" })
                      : t("company.confirmDelete", { defaultValue: "確認刪除" })}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    {t("company.cancel", { defaultValue: "取消" })}
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                  disabled={!company}
                >
                  <Trash2 className="h-4 w-4" /> {t("company.delete", { defaultValue: "刪除公司" })}
                </Button>
              )}
            </div>
            <Button size="sm" onClick={() => setEditOpen(true)} disabled={!company}>
              <Pencil className="h-4 w-4" /> {t("company.edit", { defaultValue: "編輯" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {company && (
        <CompanyFormDialog open={editOpen} onClose={() => setEditOpen(false)} company={company} />
      )}
    </>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p>{value || "—"}</p>
    </div>
  );
}

function ContactRow({
  contact,
  onRemove,
  removing,
}: {
  contact: CompanyContact;
  onRemove: () => void;
  removing: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
      <div className="min-w-0">
        <p className="truncate font-medium">
          {contact.name || t("company.unnamedContact", { defaultValue: "(未命名聯絡人)" })}
        </p>
        {(contact.email || contact.phone) && (
          <p className="truncate text-muted-foreground">{contact.email || contact.phone}</p>
        )}
      </div>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        title={t("company.removeContact", { defaultValue: "移出公司" })}
        onClick={onRemove}
        disabled={removing}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/* ----------------------- 搜尋並加入聯絡人 ----------------------- */
function AddContactSearch({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [term, setTerm] = useState("");

  const { data: results, isFetching } = useQuery({
    queryKey: ["company-contact-search", term],
    queryFn: () => companyApi.searchContacts(term),
    enabled: term.trim().length > 0,
  });

  const assign = useMutation({
    mutationFn: (contactId: string) => companyApi.assignContact(companyId, contactId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-contacts", companyId] });
      qc.invalidateQueries({ queryKey: ["company", companyId] });
      setTerm("");
    },
  });

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1 text-xs">
        <UserPlus className="h-3.5 w-3.5" /> {t("company.addContact", { defaultValue: "加入聯絡人" })}
      </Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={t("company.addContactPlaceholder", { defaultValue: "搜尋姓名 / email / 電話…" })}
          className="h-8 pl-8"
        />
      </div>
      {term.trim().length > 0 && (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-1">
          {isFetching ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("company.searching", { defaultValue: "搜尋中…" })}
            </p>
          ) : (results ?? []).length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("company.noContactMatch", { defaultValue: "查無聯絡人" })}
            </p>
          ) : (
            (results ?? []).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => assign.mutate(r.id)}
                disabled={assign.isPending}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                  assign.isPending && "opacity-60",
                )}
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">
                    {r.name || t("company.unnamedContact", { defaultValue: "(未命名聯絡人)" })}
                  </span>
                  {(r.email || r.phone) && (
                    <span className="text-muted-foreground"> · {r.email || r.phone}</span>
                  )}
                </span>
                <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            ))
          )}
        </div>
      )}
      {assign.isError && (
        <p className="text-xs text-destructive">
          {t("company.addContactError", { defaultValue: "加入失敗,請稍後再試。" })}
        </p>
      )}
    </div>
  );
}
