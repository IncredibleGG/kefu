import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, Trash2, UserPlus, X } from "lucide-react";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useSkillGroups,
  useSkillGroupDetail,
  useStaffAdmin,
  useSkillGroupMutations,
} from "@/api/hooks";
import type { SkillGroup } from "@/types";

type Draft = { id?: string; name: string; description: string };

/** 技能組管理:CRUD + 成員加入/移出。 */
export function SkillsSettingsPage() {
  const { t } = useTranslation();
  const { data: groups, isLoading } = useSkillGroups();
  const { create, update, remove } = useSkillGroupMutations();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);

  const saving = create.isPending || update.isPending;

  async function submit() {
    if (!draft) return;
    setError(null);
    try {
      if (draft.id) {
        await update.mutateAsync({
          id: draft.id,
          body: { name: draft.name, description: draft.description || null },
        });
      } else {
        await create.mutateAsync({ name: draft.name, description: draft.description || null });
      }
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("team.skills.saveError"));
    }
  }

  return (
    <PageShell
      title={t("team.skills.title")}
      description={t("team.skills.description")}
      actions={
        <Button size="sm" onClick={() => { setError(null); setDraft({ name: "", description: "" }); }}>
          <Plus className="h-4 w-4" /> {t("team.skills.addGroup")}
        </Button>
      }
    >
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-3 py-2.5 text-left font-medium">{t("team.skills.colGroup")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("team.skills.colDesc")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("team.skills.colActions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  <tr>
                    <td colSpan={3} className="p-3">
                      <Skeleton className="h-24 w-full" />
                    </td>
                  </tr>
                ) : (groups ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-10 text-center text-xs text-muted-foreground">
                      {t("team.skills.empty")}
                    </td>
                  </tr>
                ) : (
                  (groups ?? []).map((g) => (
                    <tr key={g.id} className="hover:bg-accent/40">
                      <td className="px-3 py-2.5 font-medium">{g.name}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{g.description || "—"}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-1">
                          <Button variant="outline" size="sm" onClick={() => setManageId(g.id)}>
                            <UserPlus className="h-4 w-4" /> {t("team.skills.members")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                              setError(null);
                              setDraft({ id: g.id, name: g.name, description: g.description ?? "" });
                            }}
                            aria-label={t("team.skills.edit")}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                              if (confirm(t("team.skills.confirmDelete", { name: g.name }))) remove.mutate(g.id);
                            }}
                            aria-label={t("team.skills.delete")}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 新增 / 編輯技能組 */}
      <Dialog open={!!draft} onOpenChange={(v) => !v && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("team.skills.editGroup") : t("team.skills.addGroup")}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="g-name">{t("team.skills.name")}</Label>
                <Input
                  id="g-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t("team.skills.namePlaceholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="g-desc">{t("team.skills.descLabel")}</Label>
                <Textarea
                  id="g-desc"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder={t("team.skills.descPlaceholder")}
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              {t("team.skills.cancel")}
            </Button>
            <Button onClick={submit} disabled={saving || !draft?.name.trim()}>
              {saving ? t("team.skills.saving") : t("team.skills.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MembersDialog
        group={(groups ?? []).find((g) => g.id === manageId) ?? null}
        onClose={() => setManageId(null)}
      />
    </PageShell>
  );
}

/** 成員管理對話框:列出組員可移出,並從坐席清單挑選加入。 */
function MembersDialog({ group, onClose }: { group: SkillGroup | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: detail, isLoading } = useSkillGroupDetail(group?.id);
  const { data: allStaff } = useStaffAdmin();
  const { addMembers, removeMember } = useSkillGroupMutations();

  const memberIds = useMemo(() => new Set((detail?.members ?? []).map((m) => m.id)), [detail]);
  const candidates = (allStaff ?? []).filter((s) => !memberIds.has(s.id) && s.is_active);

  return (
    <Dialog open={!!group} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("team.skills.membersTitle", { name: group?.name })}</DialogTitle>
          <DialogDescription>{t("team.skills.membersDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">{t("team.skills.currentMembers")}</Label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {isLoading ? (
                <Skeleton className="h-6 w-40" />
              ) : (detail?.members ?? []).length === 0 ? (
                <span className="text-xs text-muted-foreground">{t("team.skills.noMembers")}</span>
              ) : (
                (detail?.members ?? []).map((m) => (
                  <Badge key={m.id} variant="secondary" className="gap-1 pr-1">
                    {m.display_name}
                    <button
                      type="button"
                      onClick={() =>
                        group && removeMember.mutate({ id: group.id, staffId: m.id })
                      }
                      className="rounded-sm p-0.5 hover:bg-destructive/20"
                      aria-label={t("team.skills.removeMember")}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))
              )}
            </div>
          </div>

          <div>
            <Label className="text-xs text-muted-foreground">{t("team.skills.candidates")}</Label>
            <div className="mt-1.5 max-h-48 overflow-y-auto rounded-md border border-border">
              {candidates.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {t("team.skills.noCandidates")}
                </p>
              ) : (
                candidates.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between px-3 py-2 hover:bg-accent/40"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm">{s.display_name}</p>
                      <p className="truncate text-xs text-muted-foreground">{s.email}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => group && addMembers.mutate({ id: group.id, staffIds: [s.id] })}
                    >
                      <UserPlus className="h-4 w-4" /> {t("team.skills.add")}
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("team.skills.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
