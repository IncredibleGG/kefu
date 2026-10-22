import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, KeyRound, Search, ShieldCheck, Users, Mail, Copy, Check, Clock, RefreshCw, X, Link2 } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import {
  useStaffAdmin,
  useRoles,
  useSkillGroups,
  useStaffMutations,
  useSkillGroupMutations,
} from "@/api/hooks";
import { agentStatusMeta } from "@/lib/channels";
import { initials } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { ApiError } from "@/api/client";
import { publicUrl } from "@/lib/server";
import {
  inviteStaff,
  listPendingInvites,
  resendInvite,
  revokeInvite,
  staffResetLink,
  type InviteStaffResult,
  type PendingInvite,
  type StaffResetLinkResult,
} from "@/api/invite";
import type { StaffAdmin } from "@/types";

/** 邀請 / 重設連結:新版後端回絕對網址 invite_link / reset_link(以伺服器的前端網址為準),
 *  舊版只有相對 invite_url / reset_url → 以伺服器公開網址補前綴(原生殼不可用 App 自己的 origin)。 */
function absLink(abs: unknown, rel: string): string {
  if (typeof abs === "string" && /^https?:\/\//i.test(abs)) return abs;
  return /^https?:\/\//i.test(rel) ? rel : publicUrl(rel);
}
function inviteLinkOf(r: { invite_url: string }): string {
  return absLink((r as { invite_link?: unknown }).invite_link, r.invite_url);
}
function resetLinkOf(r: { reset_url: string }): string {
  return absLink((r as { reset_link?: unknown }).reset_link, r.reset_url);
}

type Draft = {
  id?: string;
  email: string;
  display_name: string;
  password: string;
  roleIds: string[];
  groupIds: string[];
  origGroupIds: string[];
  is_active: boolean;
};

const EMPTY: Draft = {
  email: "",
  display_name: "",
  password: "",
  roleIds: [],
  groupIds: [],
  origGroupIds: [],
  is_active: true,
};

/** 團隊 / 坐席管理:列出坐席、建立坐席、指派角色與技能組、啟停用、重設密碼。全接真 API。 */
export function StaffSettingsPage() {
  const { t } = useTranslation();
  const { data: staff, isLoading } = useStaffAdmin();
  const { data: roles } = useRoles();
  const { data: groups } = useSkillGroups();
  const { create, update, remove, setRoles, setPassword } = useStaffMutations();
  const { addMembers, removeMember } = useSkillGroupMutations();

  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pwTarget, setPwTarget] = useState<StaffAdmin | null>(null);
  const [pw, setPw] = useState("");
  // 邀請坐席:對話框輸入(email + 角色)→ 產生可複製的邀請連結
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("agent");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteResult, setInviteResult] = useState<InviteStaffResult | null>(null);
  const [copied, setCopied] = useState(false);
  // 待接受的邀請(pending):列出 + 重寄 / 撤銷。以本地 state 管理,不改 hooks.ts。
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const [pendingBusy, setPendingBusy] = useState<string | null>(null);
  // 產生密碼重設連結(管理員主動;供 demo / 無 SMTP 時仍可重設)→ 顯示可複製連結
  const [resetLinkResult, setResetLinkResult] = useState<StaffResetLinkResult | null>(null);
  const [resetLinkBusy, setResetLinkBusy] = useState<string | null>(null);
  const [resetLinkCopied, setResetLinkCopied] = useState(false);

  const loadPending = useCallback(async () => {
    try {
      setPending(await listPendingInvites());
    } catch {
      /* 無權限或後端未就緒時靜默略過,不阻斷坐席頁 */
    }
  }, []);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  async function resendPending(inv: PendingInvite) {
    setPendingBusy(inv.staff_id);
    try {
      const res = await resendInvite(inv.staff_id);
      // 以邀請結果視圖顯示新連結(舊連結因重簽而失效);role 僅供型別完整,結果視圖不使用
      setInviteResult({ ...res, role: inv.roles[0] ?? "agent" });
      setCopied(false);
      setInviteOpen(true);
      await loadPending();
      qc.invalidateQueries({ queryKey: ["iam"] });
    } catch (e) {
      alert(
        e instanceof Error
          ? e.message
          : t("team.staff.resendError", { defaultValue: "重寄邀請失敗,請稍後再試" }),
      );
    } finally {
      setPendingBusy(null);
    }
  }

  async function revokePending(inv: PendingInvite) {
    if (
      !confirm(
        t("team.staff.revokeConfirm", {
          email: inv.email,
          defaultValue: "確定撤銷對 {{email}} 的邀請?此連結將立即失效。",
        }),
      )
    )
      return;
    setPendingBusy(inv.staff_id);
    try {
      await revokeInvite(inv.staff_id);
      await loadPending();
      qc.invalidateQueries({ queryKey: ["iam"] });
    } catch (e) {
      alert(
        e instanceof Error
          ? e.message
          : t("team.staff.revokeError", { defaultValue: "撤銷邀請失敗,請稍後再試" }),
      );
    } finally {
      setPendingBusy(null);
    }
  }

  function openInvite() {
    setInviteEmail("");
    setInviteRole("agent");
    setInviteError(null);
    setInviteResult(null);
    setCopied(false);
    setInviteOpen(true);
  }

  async function submitInvite() {
    const email = inviteEmail.trim();
    if (email.length < 3) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const res = await inviteStaff({ email, role: inviteRole || undefined });
      setInviteResult(res);
      // 新坐席(待接受)已建立 → 刷新坐席列表與 pending 邀請清單
      qc.invalidateQueries({ queryKey: ["iam"] });
      void loadPending();
    } catch (e) {
      if (e instanceof ApiError && e.code === "STAFF_EMAIL_TAKEN") {
        setInviteError(t("team.staff.inviteEmailTaken", { defaultValue: "此 Email 已存在於本團隊" }));
      } else if (e instanceof ApiError && e.code === "INVALID_EMAIL") {
        setInviteError(t("team.staff.inviteEmailInvalid", { defaultValue: "電子郵件格式不正確" }));
      } else if (e instanceof ApiError && e.code === "ROLE_NOT_FOUND") {
        setInviteError(t("team.staff.inviteRoleNotFound", { defaultValue: "指派的角色不存在" }));
      } else {
        setInviteError(e instanceof Error ? e.message : t("team.staff.inviteError", { defaultValue: "邀請失敗,請稍後再試" }));
      }
    } finally {
      setInviteBusy(false);
    }
  }

  async function copyInviteLink() {
    if (!inviteResult) return;
    const link = inviteLinkOf(inviteResult);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪貼簿不可用時,使用者仍可手動選取欄位複製 */
    }
  }

  const rows = useMemo(() => {
    const list = staff ?? [];
    if (!q.trim()) return list;
    const kw = q.toLowerCase();
    return list.filter(
      (s) => s.display_name.toLowerCase().includes(kw) || s.email.toLowerCase().includes(kw),
    );
  }, [staff, q]);

  function openNew() {
    setError(null);
    setDraft({ ...EMPTY });
  }

  function openEdit(s: StaffAdmin) {
    setError(null);
    const gids = s.skill_groups.map((g) => g.id);
    setDraft({
      id: s.id,
      email: s.email,
      display_name: s.display_name,
      password: "",
      roleIds: s.roles.map((r) => r.id),
      groupIds: gids,
      origGroupIds: gids,
      is_active: s.is_active,
    });
  }

  const saving = create.isPending || update.isPending;

  async function submit() {
    if (!draft) return;
    setError(null);
    try {
      if (draft.id) {
        await update.mutateAsync({
          id: draft.id,
          body: { display_name: draft.display_name, is_active: draft.is_active },
        });
        await setRoles.mutateAsync({ id: draft.id, roleIds: draft.roleIds });
        const toAdd = draft.groupIds.filter((g) => !draft.origGroupIds.includes(g));
        const toRemove = draft.origGroupIds.filter((g) => !draft.groupIds.includes(g));
        await Promise.all([
          ...toAdd.map((g) => addMembers.mutateAsync({ id: g, staffIds: [draft.id!] })),
          ...toRemove.map((g) => removeMember.mutateAsync({ id: g, staffId: draft.id! })),
        ]);
        if (draft.password) await setPassword.mutateAsync({ id: draft.id, password: draft.password });
      } else {
        const created = await create.mutateAsync({
          email: draft.email,
          password: draft.password,
          display_name: draft.display_name,
          role_ids: draft.roleIds,
        });
        const newId = created.id;
        if (newId) {
          await Promise.all(
            draft.groupIds.map((g) => addMembers.mutateAsync({ id: g, staffIds: [newId] })),
          );
        }
      }
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("team.staff.saveError"));
    }
  }

  async function resetPassword() {
    if (!pwTarget || pw.length < 6) return;
    await setPassword.mutateAsync({ id: pwTarget.id, password: pw });
    setPwTarget(null);
    setPw("");
  }

  // 產生密碼重設連結:呼叫後端(需 staff.manage),成功後以對話框顯示可複製的完整連結。
  async function genResetLink(s: StaffAdmin) {
    setResetLinkBusy(s.id);
    try {
      const res = await staffResetLink(s.id);
      setResetLinkResult(res);
      setResetLinkCopied(false);
    } catch (e) {
      alert(
        e instanceof Error
          ? e.message
          : t("team.staff.resetLinkError", { defaultValue: "產生重設連結失敗,請稍後再試" }),
      );
    } finally {
      setResetLinkBusy(null);
    }
  }

  async function copyResetLink() {
    if (!resetLinkResult) return;
    const link = resetLinkOf(resetLinkResult);
    try {
      await navigator.clipboard.writeText(link);
      setResetLinkCopied(true);
      setTimeout(() => setResetLinkCopied(false), 1500);
    } catch {
      /* 剪貼簿不可用時,使用者仍可手動選取欄位複製 */
    }
  }

  function toggleId(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  const canSubmit =
    !!draft &&
    draft.display_name.trim().length > 0 &&
    (draft.id ? true : draft.email.trim().length >= 3 && draft.password.length >= 6);

  return (
    <PageShell
      title={t("team.staff.title")}
      description={t("team.staff.description")}
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={openInvite}>
            <Mail className="h-4 w-4" /> {t("team.staff.invite", { defaultValue: "邀請坐席" })}
          </Button>
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4" /> {t("team.staff.addStaff")}
          </Button>
        </div>
      }
    >
      <div className="relative mb-3 w-64 max-w-full">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("team.staff.searchPlaceholder")}
          className="h-8 pl-8"
        />
      </div>

      {pending.length > 0 && (
        <Card className="mb-3">
          <CardContent className="p-0">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-sm font-medium">
              <Clock className="h-4 w-4 text-muted-foreground" />
              {t("team.staff.pendingTitle", { defaultValue: "待接受的邀請" })}
              <Badge variant="secondary">{pending.length}</Badge>
            </div>
            <ul className="divide-y divide-border">
              {pending.map((inv) => (
                <li key={inv.staff_id} className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{inv.email}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {inv.roles.length ? (
                        inv.roles.map((r) => (
                          <Badge key={r} variant="brand" className="gap-1">
                            <ShieldCheck className="h-3 w-3" />
                            {r}
                          </Badge>
                        ))
                      ) : (
                        <span>{t("team.staff.unassigned")}</span>
                      )}
                      {inv.invited_at && (
                        <span>
                          {t("team.staff.invitedAt", { defaultValue: "邀請於" })}{" "}
                          {new Date(inv.invited_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => resendPending(inv)}
                      disabled={pendingBusy === inv.staff_id}
                      aria-label={t("team.staff.resend", { defaultValue: "重寄邀請" })}
                      title={t("team.staff.resend", { defaultValue: "重寄邀請" })}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => revokePending(inv)}
                      disabled={pendingBusy === inv.staff_id}
                      aria-label={t("team.staff.revoke", { defaultValue: "撤銷邀請" })}
                      title={t("team.staff.revoke", { defaultValue: "撤銷邀請" })}
                      className="text-destructive hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-3 py-2.5 text-left font-medium">{t("team.staff.colStaff")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("team.staff.roles")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("team.staff.skillGroups")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("team.staff.colStatus")}</th>
                  <th className="px-3 py-2.5 text-center font-medium">{t("team.staff.active")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("team.staff.colActions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  <tr>
                    <td colSpan={6} className="p-3">
                      <Skeleton className="h-32 w-full" />
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                      {t("team.staff.empty")}
                    </td>
                  </tr>
                ) : (
                  rows.map((s) => {
                    const sm = agentStatusMeta[s.status];
                    return (
                      <tr key={s.id} className="hover:bg-accent/40">
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <Avatar className="h-7 w-7">
                              <AvatarFallback>{initials(s.display_name)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="truncate font-medium">{s.display_name}</p>
                              <p className="truncate text-xs text-muted-foreground">{s.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {s.roles.length ? (
                              s.roles.map((r) => (
                                <Badge key={r.id} variant="brand" className="gap-1">
                                  <ShieldCheck className="h-3 w-3" />
                                  {r.name}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-xs text-muted-foreground">{t("team.staff.unassigned")}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {s.skill_groups.length ? (
                              s.skill_groups.map((g) => (
                                <Badge key={g.id} variant="secondary">
                                  {g.name}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <span className={cn("h-2 w-2 rounded-full", sm.dot)} />
                            {sm.label}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <Switch
                            checked={s.is_active}
                            onCheckedChange={(v) =>
                              update.mutate({ id: s.id, body: { is_active: v } })
                            }
                            aria-label={t("team.staff.active")}
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => openEdit(s)}
                              aria-label={t("team.staff.edit")}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => {
                                setPw("");
                                setPwTarget(s);
                              }}
                              aria-label={t("team.staff.resetPassword")}
                            >
                              <KeyRound className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => genResetLink(s)}
                              disabled={resetLinkBusy === s.id}
                              aria-label={t("team.staff.resetLink", { defaultValue: "產生重設連結" })}
                              title={t("team.staff.resetLink", { defaultValue: "產生重設連結" })}
                            >
                              <Link2 className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => {
                                if (confirm(t("team.staff.confirmDelete", { name: s.display_name }))) remove.mutate(s.id);
                              }}
                              aria-label={t("team.staff.delete")}
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 新增 / 編輯坐席 */}
      <Dialog open={!!draft} onOpenChange={(v) => !v && setDraft(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("team.staff.editStaff") : t("team.staff.addStaff")}</DialogTitle>
            <DialogDescription>
              {t("team.staff.dialogDesc")}
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="s-email">Email</Label>
                  <Input
                    id="s-email"
                    type="email"
                    value={draft.email}
                    disabled={!!draft.id}
                    onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                    placeholder="agent@example.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="s-name">{t("team.staff.displayName")}</Label>
                  <Input
                    id="s-name"
                    value={draft.display_name}
                    onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
                    placeholder={t("team.staff.displayNamePlaceholder")}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="s-pw">{draft.id ? t("team.staff.resetPwLabel") : t("team.staff.initialPw")}</Label>
                <Input
                  id="s-pw"
                  type="password"
                  value={draft.password}
                  onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                  placeholder={t("team.staff.pwPlaceholder")}
                  className="font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" /> {t("team.staff.roles")}
                </Label>
                <div className="flex flex-wrap gap-1.5 rounded-md border border-border p-2">
                  {(roles ?? []).length === 0 && (
                    <span className="text-xs text-muted-foreground">{t("team.staff.noRoles")}</span>
                  )}
                  {(roles ?? []).map((r) => {
                    const on = draft.roleIds.includes(r.id);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setDraft({ ...draft, roleIds: toggleId(draft.roleIds, r.id) })}
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                          on
                            ? "border-brand bg-brand/10 text-brand"
                            : "border-border text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {r.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" /> {t("team.staff.skillGroups")}
                </Label>
                <div className="flex flex-wrap gap-1.5 rounded-md border border-border p-2">
                  {(groups ?? []).length === 0 && (
                    <span className="text-xs text-muted-foreground">{t("team.staff.noGroups")}</span>
                  )}
                  {(groups ?? []).map((g) => {
                    const on = draft.groupIds.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() =>
                          setDraft({ ...draft, groupIds: toggleId(draft.groupIds, g.id) })
                        }
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                          on
                            ? "border-brand bg-brand/10 text-brand"
                            : "border-border text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {g.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {draft.id && (
                <div className="flex items-center justify-between rounded-md border border-border p-3">
                  <div>
                    <p className="text-sm">{t("team.staff.accountActive")}</p>
                    <p className="text-xs text-muted-foreground">{t("team.staff.accountActiveHint")}</p>
                  </div>
                  <Switch
                    checked={draft.is_active}
                    onCheckedChange={(v) => setDraft({ ...draft, is_active: v })}
                  />
                </div>
              )}

              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              {t("team.staff.cancel")}
            </Button>
            <Button onClick={submit} disabled={saving || !canSubmit}>
              {saving ? t("team.staff.saving") : t("team.staff.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重設密碼 */}
      <Dialog open={!!pwTarget} onOpenChange={(v) => !v && setPwTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("team.staff.resetPassword")}</DialogTitle>
            <DialogDescription>
              {t("team.staff.resetPwDesc", { name: pwTarget?.display_name })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="pw-new">{t("team.staff.newPw")}</Label>
            <Input
              id="pw-new"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder={t("team.staff.pwPlaceholder")}
              className="font-mono"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwTarget(null)}>
              {t("team.staff.cancel")}
            </Button>
            <Button onClick={resetPassword} disabled={pw.length < 6 || setPassword.isPending}>
              {setPassword.isPending ? t("team.staff.updating") : t("team.staff.updatePw")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 產生重設連結:管理員主動為坐席產生可複製的密碼重設連結(demo / 無 SMTP 亦可用) */}
      <Dialog open={!!resetLinkResult} onOpenChange={(v) => !v && setResetLinkResult(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("team.staff.resetLinkTitle", { defaultValue: "密碼重設連結" })}</DialogTitle>
            <DialogDescription>
              {t("team.staff.resetLinkDesc", {
                email: resetLinkResult?.email,
                defaultValue: "已為 {{email}} 產生密碼重設連結,請複製並轉交本人;連結 30 分鐘內有效、僅能使用一次。",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {resetLinkResult?.email_sent && (
              <p className="text-xs text-success">
                {t("team.staff.resetLinkEmailSent", { defaultValue: "已同時寄出重設信至該坐席信箱。" })}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={resetLinkResult ? resetLinkOf(resetLinkResult) : ""}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={copyResetLink}
                aria-label={t("team.staff.copyLink", { defaultValue: "複製連結" })}
              >
                {resetLinkCopied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setResetLinkResult(null)}>
              {t("team.staff.close", { defaultValue: "關閉" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 邀請坐席:email + 角色 → 產生可複製的邀請連結 */}
      <Dialog open={inviteOpen} onOpenChange={(v) => !v && setInviteOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("team.staff.inviteTitle", { defaultValue: "邀請坐席" })}</DialogTitle>
            <DialogDescription>
              {t("team.staff.inviteDesc", {
                defaultValue:
                  "以 Email 邀請新坐席加入本團隊;產生邀請連結後發送給對方,對方設定密碼即可加入。",
              })}
            </DialogDescription>
          </DialogHeader>

          {inviteResult ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("team.staff.inviteLinkReady", { defaultValue: "邀請連結已產生,請複製並發送給對方:" })}
              </p>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={inviteLinkOf(inviteResult)}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={copyInviteLink}
                  aria-label={t("team.staff.copyLink", { defaultValue: "複製連結" })}
                >
                  {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("team.staff.inviteHint", {
                  defaultValue: "對方開啟連結、設定密碼後即完成加入;連結 7 天內有效。",
                })}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="inv-email">Email</Label>
                <Input
                  id="inv-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="agent@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" /> {t("team.staff.inviteRole", { defaultValue: "角色" })}
                </Label>
                <div className="flex flex-wrap gap-1.5 rounded-md border border-border p-2">
                  {(roles ?? []).length === 0 && (
                    <span className="text-xs text-muted-foreground">{t("team.staff.noRoles")}</span>
                  )}
                  {(roles ?? []).map((r) => {
                    const on = inviteRole === r.name;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setInviteRole(r.name)}
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                          on
                            ? "border-brand bg-brand/10 text-brand"
                            : "border-border text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {r.name}
                      </button>
                    );
                  })}
                </div>
              </div>
              {inviteError && <p className="text-xs text-destructive">{inviteError}</p>}
            </div>
          )}

          <DialogFooter>
            {inviteResult ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    setInviteResult(null);
                    setInviteEmail("");
                    setInviteRole("agent");
                    setInviteError(null);
                  }}
                >
                  {t("team.staff.inviteAnother", { defaultValue: "再邀請一位" })}
                </Button>
                <Button onClick={() => setInviteOpen(false)}>
                  {t("team.staff.close", { defaultValue: "關閉" })}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setInviteOpen(false)}>
                  {t("team.staff.cancel")}
                </Button>
                <Button onClick={submitInvite} disabled={inviteBusy || inviteEmail.trim().length < 3}>
                  {inviteBusy
                    ? t("team.staff.inviting", { defaultValue: "產生中…" })
                    : t("team.staff.inviteSubmit", { defaultValue: "產生邀請連結" })}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
