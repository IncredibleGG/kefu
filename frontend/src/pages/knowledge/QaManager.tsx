import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  knowledgeContentApi,
  kkeys,
  type KnowledgeQaPair,
} from "@/api/knowledgeContent";

type Draft = { id?: string; question: string; answer: string };

export function QaManager({ collectionId }: { collectionId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: kkeys.qa(collectionId),
    queryFn: () => knowledgeContentApi.listQa(collectionId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: kkeys.qa(collectionId) });
  const create = useMutation({
    mutationFn: (b: { question: string; answer: string }) =>
      knowledgeContentApi.createQa(collectionId, b.question, b.answer),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (b: { id: string; question: string; answer: string }) =>
      knowledgeContentApi.updateQa(b.id, { question: b.question, answer: b.answer }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => knowledgeContentApi.deleteQa(id),
    onSuccess: invalidate,
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const rows = data ?? [];
  const saving = create.isPending || update.isPending;

  function openNew() {
    setFormError(null);
    setDraft({ question: "", answer: "" });
  }
  function openEdit(q: KnowledgeQaPair) {
    setFormError(null);
    setDraft({ id: q.id, question: q.question, answer: q.answer });
  }

  async function submit() {
    if (!draft) return;
    setFormError(null);
    try {
      if (draft.id) {
        await update.mutateAsync({ id: draft.id, question: draft.question, answer: draft.answer });
      } else {
        await create.mutateAsync({ question: draft.question, answer: draft.answer });
      }
      setDraft(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t("knowledge.manage.saveError"));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t("knowledge.manage.qaHint")}</p>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4" /> {t("knowledge.manage.addQa")}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : isError ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-sm text-destructive">
              {t("knowledge.manage.qaLoadError")}
              {error instanceof Error ? `:${error.message}` : ""}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {t("knowledge.manage.retry")}
            </Button>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("knowledge.manage.qaEmpty")}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((q) => (
            <Card key={q.id}>
              <CardContent className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{q.question}</p>
                    <Badge variant={q.embedded ? "success" : "secondary"} className="shrink-0">
                      {q.embedded ? t("knowledge.manage.embeddedYes") : t("knowledge.manage.embeddedNo")}
                    </Badge>
                  </div>
                  <p className="whitespace-pre-wrap text-xs text-muted-foreground">{q.answer}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => openEdit(q)}
                    aria-label={t("knowledge.manage.edit")}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (confirm(t("knowledge.manage.confirmDeleteQa"))) remove.mutate(q.id);
                    }}
                    aria-label={t("knowledge.manage.deleteQa")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!draft} onOpenChange={(v) => !v && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {draft?.id ? t("knowledge.manage.editQa") : t("knowledge.manage.addQa")}
            </DialogTitle>
            <DialogDescription>{t("knowledge.manage.qaDialogDesc")}</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="qa-q">{t("knowledge.manage.question")}</Label>
                <Textarea
                  id="qa-q"
                  value={draft.question}
                  onChange={(e) => setDraft({ ...draft, question: e.target.value })}
                  placeholder={t("knowledge.manage.questionPlaceholder")}
                  className="min-h-[70px]"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qa-a">{t("knowledge.manage.answer")}</Label>
                <Textarea
                  id="qa-a"
                  value={draft.answer}
                  onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
                  placeholder={t("knowledge.manage.answerPlaceholder")}
                  className="min-h-[120px]"
                />
              </div>
              {formError && <p className="text-xs text-destructive">{formError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              {t("knowledge.manage.cancel")}
            </Button>
            <Button
              onClick={submit}
              disabled={saving || !draft?.question.trim() || !draft?.answer.trim()}
            >
              {saving ? t("knowledge.manage.saving") : t("knowledge.manage.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
