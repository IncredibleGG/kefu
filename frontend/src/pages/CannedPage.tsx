import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Users, User, Search, AlertCircle } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCanned, useCannedMutations } from "@/api/hooks";
import { iamApi } from "@/api/endpoints";
import { cn } from "@/lib/utils";
import type { Canned } from "@/types";

const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

type Draft = {
  id?: string;
  title: string;
  shortcut: string;
  content: string;
  shared: boolean;
  skill_group_id: string;
};

const EMPTY: Draft = { title: "", shortcut: "", content: "", shared: false, skill_group_id: "" };

export function CannedPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "shared" | "mine">("all");
  const { data, isLoading, isError, refetch } = useCanned(scope, q || undefined);
  const { create, update, remove } = useCannedMutations();
  const groups = useQuery({ queryKey: ["iam", "skillGroups"], queryFn: () => iamApi.skillGroups() });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  function openNew() {
    setError(null);
    setDraft({ ...EMPTY });
  }
  function openEdit(c: Canned) {
    setError(null);
    setDraft({
      id: c.id,
      title: c.title,
      shortcut: c.shortcut,
      content: c.content,
      shared: c.shared,
      skill_group_id: c.skill_group_id ?? "",
    });
  }

  async function submit() {
    if (!draft) return;
    setError(null);
    try {
      if (draft.id) {
        await update.mutateAsync({
          id: draft.id,
          body: {
            title: draft.title,
            shortcut: draft.shortcut,
            content: draft.content,
            skill_group_id: draft.skill_group_id || null,
          },
        });
      } else {
        await create.mutateAsync({
          title: draft.title,
          shortcut: draft.shortcut,
          content: draft.content,
          shared: draft.shared,
          skill_group_id: draft.skill_group_id || null,
        });
      }
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("team.canned.saveError"));
    }
  }

  const groupName = (id?: string | null) =>
    id ? groups.data?.find((g) => g.id === id)?.name ?? t("team.canned.skillGroup") : null;

  const rows = data ?? [];
  const saving = create.isPending || update.isPending;

  return (
    <PageShell
      title={t("team.canned.pageTitle")}
      description={t("team.canned.pageDesc", { ph: "{{變數}}" })}
      actions={
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4" /> {t("team.canned.addCanned")}
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-64 max-w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("team.canned.searchPlaceholder")} className="h-8 pl-8" />
        </div>
        <div className="flex gap-1">
          {(["all", "shared", "mine"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                scope === s ? "border-brand bg-brand/10 text-brand" : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {s === "all" ? t("team.canned.scopeAll") : s === "shared" ? t("team.canned.scopeShared") : t("team.canned.scopeMine")}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-3 py-2.5 text-left font-medium">{t("team.canned.colTitle")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("team.canned.colShortcut")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("team.canned.colContent")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("team.canned.colScope")}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t("team.canned.skillGroup")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("team.canned.colActions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  <tr>
                    <td colSpan={6} className="p-3">
                      <Skeleton className="h-24 w-full" />
                    </td>
                  </tr>
                ) : isError ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10">
                      <div className="flex flex-col items-center justify-center gap-2 text-center">
                        <AlertCircle className="h-6 w-6 text-destructive" />
                        <p className="text-sm text-muted-foreground">{t("reports.loadError")}</p>
                        <button
                          type="button"
                          onClick={() => refetch()}
                          className="text-xs text-primary underline-offset-2 hover:underline"
                        >
                          {t("reports.retry")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                      {t("team.canned.empty")}
                    </td>
                  </tr>
                ) : (
                  rows.map((c) => (
                    <tr key={c.id} className="hover:bg-accent/40">
                      <td className="px-3 py-2.5 font-medium">{c.title}</td>
                      <td className="px-3 py-2.5">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">/{c.shortcut}</code>
                      </td>
                      <td className="max-w-xs px-3 py-2.5">
                        <p className="truncate text-muted-foreground">{c.content}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        {c.shared ? (
                          <Badge variant="info" className="gap-1">
                            <Users className="h-3 w-3" /> {t("team.canned.scopeShared")}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1">
                            <User className="h-3 w-3" /> {t("team.canned.scopeMine")}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{groupName(c.skill_group_id) ?? "—"}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon-sm" onClick={() => openEdit(c)} aria-label={t("team.canned.edit")}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                              if (confirm(t("team.canned.confirmDelete", { title: c.title }))) remove.mutate(c.id);
                            }}
                            aria-label={t("team.canned.delete")}
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

      <Dialog open={!!draft} onOpenChange={(v) => !v && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("team.canned.editCanned") : t("team.canned.addCanned")}</DialogTitle>
            <DialogDescription>
              {t("team.canned.varHintPre")} <code className="rounded bg-muted px-1">{"{{visitor_name}}"}</code> {t("team.canned.varHintPost")}
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="c-title">{t("team.canned.colTitle")}</Label>
                  <Input
                    id="c-title"
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    placeholder={t("team.canned.titlePlaceholder")}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="c-shortcut">{t("team.canned.colShortcut")}</Label>
                  <Input
                    id="c-shortcut"
                    value={draft.shortcut}
                    onChange={(e) => setDraft({ ...draft, shortcut: e.target.value.replace(/\s/g, "") })}
                    placeholder="hello"
                    className="font-mono"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-content">{t("team.canned.colContent")}</Label>
                <Textarea
                  id="c-content"
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  placeholder={t("team.canned.contentPlaceholder", { ph: "{{visitor_name}}" })}
                  className="min-h-[120px]"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-group">{t("team.canned.groupOptional")}</Label>
                <select
                  id="c-group"
                  className={SELECT_CLS}
                  value={draft.skill_group_id}
                  onChange={(e) => setDraft({ ...draft, skill_group_id: e.target.value })}
                >
                  <option value="">{t("team.canned.groupAny")}</option>
                  {(groups.data ?? []).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
              {!draft.id && (
                <div className="flex items-center justify-between rounded-md border border-border p-3">
                  <div>
                    <p className="text-sm">{t("team.canned.sharedTitle")}</p>
                    <p className="text-xs text-muted-foreground">{t("team.canned.sharedHint")}</p>
                  </div>
                  <Switch checked={draft.shared} onCheckedChange={(v) => setDraft({ ...draft, shared: v })} />
                </div>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              {t("team.canned.cancel")}
            </Button>
            <Button onClick={submit} disabled={saving || !draft?.title || !draft?.shortcut}>
              {saving ? t("team.canned.saving") : t("team.canned.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
