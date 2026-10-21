import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  ChevronRight,
  ChevronDown,
  Plus,
  FolderPlus,
  Pencil,
  Trash2,
  Users,
  UserPlus,
  Network,
  AlertTriangle,
  ShieldAlert,
  Search,
  Check,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, initials } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { ApiError } from "@/api/client";
import {
  organizationApi,
  flattenTree,
  collectSubtreeIds,
  type OrgNode,
} from "@/api/organization";

const TREE_KEY = ["organization", "tree"] as const;

function is403(e: unknown): boolean {
  return e instanceof ApiError && e.httpStatus === 403;
}

/** 建立 / 編輯部門的表單草稿 */
type Draft = {
  mode: "create" | "edit";
  id?: string; // edit 目標
  name: string;
  parentId: string | null; // 選定上層(null=頂層)
  fixedParentName?: string | null; // 新增子部門時鎖定上層並顯示其名
};

export function OrganizationPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  // organization.manage / admin 才可異動;與後端 Principal.require 同語意
  const roles = useAuth((s) => s.staff?.roles ?? []);
  const canManage = roles.includes("admin") || roles.includes("organization.manage");

  const treeQuery = useQuery({
    queryKey: TREE_KEY,
    queryFn: () => organizationApi.tree(),
  });
  const tree = treeQuery.data ?? [];
  const flat = useMemo(() => flattenTree(tree), [tree]);
  const nameById = useMemo(
    () => new Map(flat.map((n) => [n.id, n.name])),
    [flat],
  );

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [assignFor, setAssignFor] = useState<OrgNode | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const selected = selectedId ? flat.find((n) => n.id === selectedId) ?? null : null;

  /* ----------------------------- 異動 mutations ----------------------------- */
  const invalidate = () => qc.invalidateQueries({ queryKey: ["organization"] });

  const createMut = useMutation({
    mutationFn: (body: { name: string; parent_id: string | null }) =>
      organizationApi.create(body),
    onSuccess: () => {
      invalidate();
      setDraft(null);
    },
    onError: (e) => setFormError(errText(e, t("organization.saveError"))),
  });

  const updateMut = useMutation({
    mutationFn: (args: { id: string; body: { name?: string; parent_id?: string | null } }) =>
      organizationApi.update(args.id, args.body),
    onSuccess: () => {
      invalidate();
      setDraft(null);
    },
    onError: (e) => setFormError(errText(e, t("organization.saveError"))),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => organizationApi.remove(id),
    onSuccess: (_data, id) => {
      invalidate();
      if (selectedId === id) setSelectedId(null);
    },
    onError: (e) => setRowError(errText(e, t("organization.deleteError"))),
  });

  function errText(e: unknown, fallback: string): string {
    if (is403(e)) return t("organization.permissionDenied");
    if (e instanceof ApiError && e.code === "ORG_CYCLE") return t("organization.cycleError");
    return e instanceof Error ? e.message : fallback;
  }

  /* ------------------------------- 樹操作 ------------------------------- */
  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function openCreateRoot() {
    setFormError(null);
    setDraft({ mode: "create", name: "", parentId: null });
  }
  function openCreateChild(parent: OrgNode) {
    setFormError(null);
    setDraft({ mode: "create", name: "", parentId: parent.id, fixedParentName: parent.name });
  }
  function openEdit(node: OrgNode) {
    setFormError(null);
    setDraft({ mode: "edit", id: node.id, name: node.name, parentId: node.parent_id });
  }

  function askDelete(node: OrgNode) {
    setRowError(null);
    const msg = `${t("organization.confirmDelete", { name: node.name })}\n\n${t("organization.deleteHint")}`;
    if (confirm(msg)) removeMut.mutate(node.id);
  }

  function submitDraft() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) return;
    setFormError(null);
    if (draft.mode === "create") {
      createMut.mutate({ name, parent_id: draft.parentId });
    } else if (draft.id) {
      updateMut.mutate({ id: draft.id, body: { name, parent_id: draft.parentId } });
    }
  }

  // 編輯時,上層候選需排除自己與所有後代(防環);建立時無此限制
  const parentOptions = useMemo(() => {
    if (!draft) return flat;
    if (draft.mode === "edit" && draft.id) {
      const self = flat.find((n) => n.id === draft.id);
      const banned = self ? collectSubtreeIds(self) : new Set<string>();
      return flat.filter((n) => !banned.has(n.id));
    }
    return flat;
  }, [draft, flat]);

  const saving = createMut.isPending || updateMut.isPending;

  /* --------------------------- 全頁 403 / 載入 / 錯誤 --------------------------- */
  if (is403(treeQuery.error)) {
    return (
      <PageShell title={t("organization.title")} description={t("organization.description")}>
        <PermissionDenied />
      </PageShell>
    );
  }

  return (
    <PageShell
      title={t("organization.title")}
      description={t("organization.description")}
      actions={
        canManage ? (
          <Button size="sm" onClick={openCreateRoot}>
            <Plus className="h-4 w-4" /> {t("organization.addRoot")}
          </Button>
        ) : undefined
      }
    >
      {!canManage && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <span>{t("organization.readOnlyBanner")}</span>
        </div>
      )}
      {rowError && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{rowError}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* 組織樹 */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center gap-2">
            <Network className="h-4 w-4 text-brand" />
            <CardTitle className="text-sm">{t("organization.treeTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {treeQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-5/6" />
                <Skeleton className="h-8 w-2/3" />
              </div>
            ) : treeQuery.isError ? (
              <div className="py-10 text-center">
                <p className="text-sm text-destructive">{t("organization.loadError")}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => treeQuery.refetch()}
                >
                  {t("organization.retry")}
                </Button>
              </div>
            ) : tree.length === 0 ? (
              <div className="py-12 text-center text-xs text-muted-foreground">
                {t("organization.empty")}
              </div>
            ) : (
              <ul className="space-y-0.5">
                {tree.map((node) => (
                  <TreeRow
                    key={node.id}
                    node={node}
                    depth={0}
                    collapsed={collapsed}
                    selectedId={selectedId}
                    canManage={canManage}
                    onToggle={toggle}
                    onSelect={setSelectedId}
                    onAddChild={openCreateChild}
                    onEdit={openEdit}
                    onDelete={askDelete}
                    t={t}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* 部門詳情 / 坐席 */}
        <Card className="lg:col-span-1">
          <CardHeader className="flex-row items-center gap-2">
            <Building2 className="h-4 w-4 text-brand" />
            <CardTitle className="text-sm">{t("organization.detailTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {!selected ? (
              <p className="py-10 text-center text-xs text-muted-foreground">
                {t("organization.selectHint")}
              </p>
            ) : (
              <DetailPanel
                node={selected}
                canManage={canManage}
                onAssign={() => setAssignFor(selected)}
                t={t}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* 建立 / 編輯部門對話框 */}
      <Dialog open={!!draft} onOpenChange={(v) => !v && setDraft(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {draft?.mode === "edit"
                ? t("organization.editTitle")
                : draft?.fixedParentName
                  ? t("organization.createChildTitle", { parent: draft.fixedParentName })
                  : t("organization.createTitle")}
            </DialogTitle>
            <DialogDescription>{t("organization.parentHint")}</DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="org-name">{t("organization.name")}</Label>
                <Input
                  id="org-name"
                  autoFocus
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && draft.name.trim() && submitDraft()}
                  placeholder={t("organization.namePlaceholder")}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="org-parent">{t("organization.parent")}</Label>
                {draft.mode === "create" && draft.fixedParentName ? (
                  <Input id="org-parent" value={draft.fixedParentName} disabled />
                ) : (
                  <select
                    id="org-parent"
                    value={draft.parentId ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, parentId: e.target.value || null })
                    }
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  >
                    <option value="">{t("organization.parentRoot")}</option>
                    {parentOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {formError && <p className="text-xs text-destructive">{formError}</p>}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              {t("organization.cancel")}
            </Button>
            <Button onClick={submitDraft} disabled={saving || !draft?.name.trim()}>
              {saving
                ? draft?.mode === "edit"
                  ? t("organization.saving")
                  : t("organization.creating")
                : draft?.mode === "edit"
                  ? t("organization.save")
                  : t("organization.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 指派坐席對話框 */}
      {assignFor && (
        <AssignStaffDialog
          node={assignFor}
          nameById={nameById}
          onClose={() => setAssignFor(null)}
          onChanged={invalidate}
          t={t}
        />
      )}
    </PageShell>
  );
}

/* =============================== 子元件 =============================== */

type TFn = ReturnType<typeof useTranslation>["t"];

function TreeRow({
  node,
  depth,
  collapsed,
  selectedId,
  canManage,
  onToggle,
  onSelect,
  onAddChild,
  onEdit,
  onDelete,
  t,
}: {
  node: OrgNode;
  depth: number;
  collapsed: Set<string>;
  selectedId: string | null;
  canManage: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onAddChild: (n: OrgNode) => void;
  onEdit: (n: OrgNode) => void;
  onDelete: (n: OrgNode) => void;
  t: TFn;
}) {
  const hasChildren = !!node.children?.length;
  const isOpen = !collapsed.has(node.id);
  const isSelected = selectedId === node.id;

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md py-1.5 pr-1.5 transition-colors hover:bg-accent/60",
          isSelected && "bg-accent",
        )}
        style={{ paddingLeft: depth * 18 + 4 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            aria-label={t(isOpen ? "organization.collapse" : "organization.expand")}
          >
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" />
        )}

        <button
          type="button"
          onClick={() => onSelect(node.id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm">{node.name}</span>
          {hasChildren && (
            <Badge variant="secondary" className="ml-1 shrink-0">
              {node.children!.length}
            </Badge>
          )}
        </button>

        {canManage && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onAddChild(node)}
              aria-label={t("organization.addChild")}
              title={t("organization.addChild")}
            >
              <FolderPlus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onEdit(node)}
              aria-label={t("organization.edit")}
              title={t("organization.edit")}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onDelete(node)}
              aria-label={t("organization.delete")}
              title={t("organization.delete")}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {hasChildren && isOpen && (
        <ul className="space-y-0.5">
          {node.children!.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              selectedId={selectedId}
              canManage={canManage}
              onToggle={onToggle}
              onSelect={onSelect}
              onAddChild={onAddChild}
              onEdit={onEdit}
              onDelete={onDelete}
              t={t}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function DetailPanel({
  node,
  canManage,
  onAssign,
  t,
}: {
  node: OrgNode;
  canManage: boolean;
  onAssign: () => void;
  t: TFn;
}) {
  const staffQuery = useQuery({
    queryKey: ["organization", "staff", node.id],
    queryFn: () => organizationApi.staffInOrg(node.id),
  });

  const staff = staffQuery.data ?? [];
  const noPerm = is403(staffQuery.error);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">{node.name}</p>
        {node.created_at && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("organization.createdAt", { date: node.created_at.slice(0, 10) })}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          {t("organization.memberCount", { count: staff.length })}
        </span>
        {canManage && (
          <Button variant="outline" size="sm" onClick={onAssign}>
            <UserPlus className="h-4 w-4" /> {t("organization.assign")}
          </Button>
        )}
      </div>

      {staffQuery.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : noPerm ? (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {t("organization.membersNoPermission")}
        </p>
      ) : staffQuery.isError ? (
        <p className="text-xs text-destructive">{t("organization.membersLoadError")}</p>
      ) : staff.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {t("organization.membersEmpty")}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {staff.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-md border border-border p-2">
              <Avatar className="h-7 w-7">
                <AvatarFallback>{initials(s.display_name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm">{s.display_name}</p>
                <p className="truncate text-xs text-muted-foreground">{s.email}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AssignStaffDialog({
  node,
  nameById,
  onClose,
  onChanged,
  t,
}: {
  node: OrgNode;
  nameById: Map<string, string>;
  onClose: () => void;
  onChanged: () => void;
  t: TFn;
}) {
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const allQuery = useQuery({
    queryKey: ["organization", "allStaff"],
    queryFn: () => organizationApi.allStaff(),
  });

  const assignMut = useMutation({
    mutationFn: (args: { staffId: string; orgId: string | null }) =>
      organizationApi.assignStaff(args.staffId, args.orgId),
    onMutate: (args) => setPendingId(args.staffId),
    onSuccess: () => {
      onChanged();
      allQuery.refetch();
    },
    onError: (e) =>
      setError(is403(e) ? t("organization.assignNoPermission") : t("organization.assignError")),
    onSettled: () => setPendingId(null),
  });

  const all = allQuery.data ?? [];
  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return all;
    return all.filter(
      (s) =>
        s.display_name.toLowerCase().includes(kw) || s.email.toLowerCase().includes(kw),
    );
  }, [all, q]);

  const noPerm = is403(allQuery.error);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("organization.assignTitle", { name: node.name })}</DialogTitle>
          <DialogDescription>{t("organization.assignDesc")}</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("organization.assignSearchPlaceholder")}
            className="h-8 pl-8"
          />
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="max-h-80 space-y-1.5 overflow-y-auto">
          {allQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : noPerm ? (
            <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              {t("organization.membersNoPermission")}
            </p>
          ) : allQuery.isError ? (
            <p className="text-xs text-destructive">{t("organization.assignLoadError")}</p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t("organization.assignEmpty")}
            </p>
          ) : (
            rows.map((s) => {
              const inThis = s.organization_id === node.id;
              const elsewhere =
                s.organization_id && s.organization_id !== node.id
                  ? nameById.get(s.organization_id)
                  : null;
              const busy = pendingId === s.id && assignMut.isPending;
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-2 rounded-md border border-border p-2"
                >
                  <Avatar className="h-7 w-7">
                    <AvatarFallback>{initials(s.display_name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{s.display_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {inThis
                        ? t("organization.assignInThis")
                        : elsewhere
                          ? t("organization.assignElsewhere", { name: elsewhere })
                          : t("organization.assignUnassigned")}
                    </p>
                  </div>
                  {inThis ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => assignMut.mutate({ staffId: s.id, orgId: null })}
                      className="text-destructive hover:text-destructive"
                    >
                      {t("organization.assignRemove")}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => assignMut.mutate({ staffId: s.id, orgId: node.id })}
                    >
                      {busy ? (
                        t("organization.saving")
                      ) : (
                        <>
                          <Check className="h-4 w-4" /> {t("organization.assignAdd")}
                        </>
                      )}
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("organization.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PermissionDenied() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <ShieldAlert className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{t("organization.noPermission")}</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        {t("organization.noPermissionDesc")}
      </p>
    </div>
  );
}
