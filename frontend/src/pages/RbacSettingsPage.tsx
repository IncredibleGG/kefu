import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, Trash2, Lock, Save, Users, UserPlus, X } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useRoles,
  useRole,
  usePermissions,
  useRoleMutations,
  useStaffAdmin,
  useStaffMutations,
} from "@/api/hooks";
import i18n from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Permission, StaffAdmin } from "@/types";

/** 權限模組前綴 → 中文分組標題(以函式回傳,確保語言切換後即時更新) */
const moduleLabels = (): Record<string, string> => ({
  tenant: i18n.t("team.rbac.module.tenant"),
  organization: i18n.t("team.rbac.module.organization"),
  staff: i18n.t("team.rbac.module.staff"),
  role: i18n.t("team.rbac.module.role"),
  skillgroup: i18n.t("team.rbac.module.skillgroup"),
  conversation: i18n.t("team.rbac.module.conversation"),
  knowledge: i18n.t("team.rbac.module.knowledge"),
  ticket: i18n.t("team.rbac.module.ticket"),
  quality: i18n.t("team.rbac.module.quality"),
  report: i18n.t("team.rbac.module.report"),
  automation: i18n.t("team.rbac.module.automation"),
  sla: "SLA",
  proactive: i18n.t("team.rbac.module.proactive"),
  settings: i18n.t("team.rbac.module.settings"),
});

function groupPermissions(perms: Permission[]): [string, Permission[]][] {
  const map = new Map<string, Permission[]>();
  for (const p of perms) {
    const key = p.code.split(".")[0];
    const arr = map.get(key) ?? [];
    arr.push(p);
    map.set(key, arr);
  }
  return [...map.entries()];
}

/** RBAC:列角色、每角色綁哪些權限碼(可勾選儲存)、可建角色。接真資料。 */
export function RbacSettingsPage() {
  const { t } = useTranslation();
  const { data: roles, isLoading } = useRoles();
  const { data: permissions } = usePermissions();
  const { create, update, remove, setPermissions } = useRoleMutations();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: role, isLoading: roleLoading } = useRole(selectedId ?? undefined);

  // 角色成員(角色↔坐席指派):以充實後的坐席清單就地推導,經 setStaffRoles 落地。
  const { data: staffAdmin, isLoading: staffLoading } = useStaffAdmin();
  const { setRoles } = useStaffMutations();

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [newRole, setNewRole] = useState({ name: "", description: "" });
  const [renameDraft, setRenameDraft] = useState<{ name: string; description: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [membersOpen, setMembersOpen] = useState(false);
  const [memberDraft, setMemberDraft] = useState<string[]>([]);
  const [memberError, setMemberError] = useState<string | null>(null);

  const MODULE_LABELS = moduleLabels();

  // 預設選第一個角色
  useEffect(() => {
    if (!selectedId && roles && roles.length > 0) setSelectedId(roles[0].id);
  }, [roles, selectedId]);

  // 角色詳情載入 → 同步權限勾選
  useEffect(() => {
    if (role) setChecked(new Set(role.permissions ?? []));
  }, [role]);

  const grouped = useMemo(() => groupPermissions(permissions ?? []), [permissions]);

  const dirty = useMemo(() => {
    if (!role) return false;
    const orig = new Set(role.permissions ?? []);
    if (orig.size !== checked.size) return true;
    for (const c of checked) if (!orig.has(c)) return true;
    return false;
  }, [role, checked]);

  function toggle(code: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleGroup(perms: Permission[], on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const p of perms) {
        if (on) next.add(p.code);
        else next.delete(p.code);
      }
      return next;
    });
  }

  async function savePermissions() {
    if (!selectedId) return;
    await setPermissions.mutateAsync({ id: selectedId, codes: [...checked] });
  }

  async function createRole() {
    setError(null);
    try {
      const created = await create.mutateAsync({
        name: newRole.name,
        description: newRole.description || null,
      });
      setCreateOpen(false);
      setNewRole({ name: "", description: "" });
      if (created?.id) setSelectedId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("team.rbac.createError"));
    }
  }

  async function saveRename() {
    if (!selectedId || !renameDraft) return;
    setError(null);
    try {
      await update.mutateAsync({
        id: selectedId,
        body: { name: renameDraft.name, description: renameDraft.description || null },
      });
      setRenameDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("team.rbac.updateError"));
    }
  }

  // 目前選定角色的成員(擁有該角色的坐席)
  const members = useMemo(
    () => (staffAdmin ?? []).filter((s) => s.roles.some((r) => r.id === selectedId)),
    [staffAdmin, selectedId],
  );

  function openMembers() {
    setMemberError(null);
    setMemberDraft(members.map((m) => m.id));
    setMembersOpen(true);
  }

  function toggleMember(id: string) {
    setMemberDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /** 覆寫單一坐席的角色集合:在其既有角色上加入 / 移除目前選定角色。 */
  async function applyRoleToStaff(s: StaffAdmin, include: boolean): Promise<void> {
    if (!selectedId) return;
    const ids = new Set(s.roles.map((r) => r.id));
    if (include) ids.add(selectedId);
    else ids.delete(selectedId);
    await setRoles.mutateAsync({ id: s.id, roleIds: [...ids] });
  }

  async function saveMembers() {
    if (!selectedId) return;
    setMemberError(null);
    const target = new Set(memberDraft);
    const before = new Set(members.map((m) => m.id));
    // 僅對「加入或移除」有變動的坐席發送請求
    const changed = (staffAdmin ?? []).filter((s) => target.has(s.id) !== before.has(s.id));
    try {
      await Promise.all(changed.map((s) => applyRoleToStaff(s, target.has(s.id))));
      setMembersOpen(false);
    } catch (e) {
      setMemberError(
        e instanceof Error ? e.message : t("rbac.members.saveError", { defaultValue: "儲存成員失敗" }),
      );
    }
  }

  async function removeMember(s: StaffAdmin) {
    setMemberError(null);
    try {
      await applyRoleToStaff(s, false);
    } catch (e) {
      setMemberError(
        e instanceof Error ? e.message : t("rbac.members.saveError", { defaultValue: "儲存成員失敗" }),
      );
    }
  }

  return (
    <PageShell
      title={t("team.rbac.title")}
      description={t("team.rbac.description")}
      actions={
        <Button size="sm" onClick={() => { setError(null); setCreateOpen(true); }}>
          <Plus className="h-4 w-4" /> {t("team.rbac.addRole")}
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
        {/* 角色清單 */}
        <Card className="h-fit">
          <CardContent className="p-2">
            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (roles ?? []).length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t("team.rbac.noRoles")}</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {(roles ?? []).map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    className={cn(
                      "flex items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors",
                      selectedId === r.id
                        ? "bg-brand/12 font-medium text-brand"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <span className="truncate">{r.name}</span>
                    {r.is_system && <Lock className="h-3 w-3 shrink-0 opacity-60" />}
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 選定角色的權限矩陣 */}
        <Card>
          <CardContent className="p-4">
            {!selectedId || roleLoading || !role ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">{role.name}</h3>
                      {role.is_system && (
                        <Badge variant="secondary" className="gap-1">
                          <Lock className="h-3 w-3" /> {t("team.rbac.systemRole")}
                        </Badge>
                      )}
                    </div>
                    {role.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{role.description}</p>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={role.is_system}
                      onClick={() =>
                        setRenameDraft({ name: role.name, description: role.description ?? "" })
                      }
                      aria-label={t("team.rbac.editRoleAria")}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={role.is_system}
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        if (confirm(t("team.rbac.confirmDelete", { name: role.name }))) {
                          remove.mutate(role.id);
                          setSelectedId(null);
                        }
                      }}
                      aria-label={t("team.rbac.deleteRoleAria")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-3">
                  {grouped.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("team.rbac.noPermissions")}
                    </p>
                  )}
                  {grouped.map(([mod, perms]) => {
                    const allOn = perms.every((p) => checked.has(p.code));
                    return (
                      <div key={mod} className="rounded-md border border-border">
                        <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5">
                          <span className="text-xs font-semibold">
                            {MODULE_LABELS[mod] ?? mod}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleGroup(perms, !allOn)}
                            className="text-[11px] text-brand hover:underline"
                          >
                            {allOn ? t("team.rbac.deselectAll") : t("team.rbac.selectAll")}
                          </button>
                        </div>
                        <div className="grid grid-cols-1 gap-1 p-2 sm:grid-cols-2">
                          {perms.map((p) => (
                            <label
                              key={p.code}
                              className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40"
                            >
                              <input
                                type="checkbox"
                                checked={checked.has(p.code)}
                                onChange={() => toggle(p.code)}
                                className="mt-0.5 h-4 w-4 accent-[hsl(var(--brand))]"
                              />
                              <span className="min-w-0">
                                <span className="block text-sm leading-tight">
                                  {p.description ?? p.code}
                                </span>
                                <code className="text-[11px] text-muted-foreground">{p.code}</code>
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 flex items-center justify-end gap-2">
                  {dirty && <span className="text-xs text-warning">{t("team.rbac.unsaved")}</span>}
                  <Button onClick={savePermissions} disabled={!dirty || setPermissions.isPending}>
                    <Save className="h-4 w-4" />
                    {setPermissions.isPending ? t("team.rbac.saving") : t("team.rbac.savePermissions")}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 角色成員:哪些坐席擁有此角色(可指派 / 移除;落地於 staff.roles) */}
      {selectedId && role && (
        <Card className="mt-4">
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Users className="h-4 w-4" />
                  {t("rbac.members.title", { defaultValue: "角色成員" })}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("rbac.members.subtitle", {
                    defaultValue: "擁有「{{name}}」角色的坐席",
                    name: role.name,
                  })}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={openMembers}>
                <UserPlus className="h-4 w-4" />
                {t("rbac.members.edit", { defaultValue: "編輯成員" })}
              </Button>
            </div>
            {staffLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : members.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                {t("rbac.members.empty", { defaultValue: "此角色尚無成員" })}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {members.map((m) => (
                  <span
                    key={m.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-1 pl-2.5 pr-1 text-xs"
                  >
                    <span className="font-medium">{m.display_name}</span>
                    <span className="text-muted-foreground">{m.email}</span>
                    <button
                      type="button"
                      onClick={() => removeMember(m)}
                      disabled={setRoles.isPending}
                      aria-label={t("rbac.members.removeAria", {
                        defaultValue: "從角色移除 {{name}}",
                        name: m.display_name,
                      })}
                      className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {memberError && <p className="mt-2 text-xs text-destructive">{memberError}</p>}
          </CardContent>
        </Card>
      )}

      {/* 新增角色 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("team.rbac.addRole")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="r-name">{t("team.rbac.roleName")}</Label>
              <Input
                id="r-name"
                value={newRole.name}
                onChange={(e) => setNewRole({ ...newRole, name: e.target.value })}
                placeholder={t("team.rbac.roleNamePlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-desc">{t("team.rbac.descOptional")}</Label>
              <Textarea
                id="r-desc"
                value={newRole.description}
                onChange={(e) => setNewRole({ ...newRole, description: e.target.value })}
                placeholder={t("team.rbac.descPlaceholder")}
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("team.rbac.cancel")}
            </Button>
            <Button onClick={createRole} disabled={!newRole.name.trim() || create.isPending}>
              {create.isPending ? t("team.rbac.creating") : t("team.rbac.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 編輯角色名稱/說明 */}
      <Dialog open={!!renameDraft} onOpenChange={(v) => !v && setRenameDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("team.rbac.editRole")}</DialogTitle>
          </DialogHeader>
          {renameDraft && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="r-name2">{t("team.rbac.roleName")}</Label>
                <Input
                  id="r-name2"
                  value={renameDraft.name}
                  onChange={(e) => setRenameDraft({ ...renameDraft, name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="r-desc2">{t("team.rbac.descLabel")}</Label>
                <Textarea
                  id="r-desc2"
                  value={renameDraft.description}
                  onChange={(e) => setRenameDraft({ ...renameDraft, description: e.target.value })}
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDraft(null)}>
              {t("team.rbac.cancel")}
            </Button>
            <Button onClick={saveRename} disabled={!renameDraft?.name.trim() || update.isPending}>
              {update.isPending ? t("team.rbac.saving") : t("team.rbac.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 指派角色成員:坐席多選 */}
      <Dialog open={membersOpen} onOpenChange={setMembersOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("rbac.members.dialogTitle", { defaultValue: "指派角色成員" })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {role && (
              <p className="text-xs text-muted-foreground">
                {t("rbac.members.dialogHint", {
                  defaultValue: "勾選要擁有「{{name}}」角色的坐席",
                  name: role.name,
                })}
              </p>
            )}
            {staffLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (staffAdmin ?? []).length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {t("rbac.members.noStaff", { defaultValue: "尚無坐席可指派" })}
              </p>
            ) : (
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
                {(staffAdmin ?? []).map((s) => {
                  const on = memberDraft.includes(s.id);
                  return (
                    <label
                      key={s.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleMember(s.id)}
                        className="h-4 w-4 accent-[hsl(var(--brand))]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm leading-tight">{s.display_name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{s.email}</span>
                      </span>
                      {!s.is_active && (
                        <Badge variant="secondary" className="text-[10px]">
                          {t("rbac.members.inactive", { defaultValue: "已停用" })}
                        </Badge>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              {t("rbac.members.selected", { defaultValue: "已選 {{count}} 位", count: memberDraft.length })}
            </p>
            {memberError && <p className="text-xs text-destructive">{memberError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMembersOpen(false)}>
              {t("rbac.members.cancel", { defaultValue: "取消" })}
            </Button>
            <Button onClick={saveMembers} disabled={setRoles.isPending}>
              {setRoles.isPending
                ? t("rbac.members.saving", { defaultValue: "儲存中…" })
                : t("rbac.members.save", { defaultValue: "儲存" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
