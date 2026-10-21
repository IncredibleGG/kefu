import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload, FileText, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
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
  groupDocuments,
  type DocumentGroup,
} from "@/api/knowledgeContent";

export function DocumentManager({ collectionId }: { collectionId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: kkeys.documents(collectionId),
    queryFn: () => knowledgeContentApi.listDocuments(collectionId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: kkeys.documents(collectionId) });

  const upload = useMutation({
    mutationFn: (file: File) => knowledgeContentApi.uploadDocument(collectionId, file),
    onSuccess: (r) => {
      invalidate();
      setNotice(
        t("knowledge.manage.uploadSuccess", { name: r.filename ?? "", chunks: r.chunks }),
      );
      setBanner(null);
    },
    onError: (e) => setBanner(e instanceof Error ? e.message : ""),
  });

  const createText = useMutation({
    mutationFn: (b: { content: string; title: string }) =>
      knowledgeContentApi.createDocument(collectionId, b.content, b.title),
    onSuccess: (r) => {
      invalidate();
      setNotice(t("knowledge.manage.textSuccess", { chunks: r.chunks }));
    },
  });

  const remove = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => knowledgeContentApi.deleteDocument(id))),
    onSuccess: invalidate,
  });

  const [notice, setNotice] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [textDraft, setTextDraft] = useState<{ title: string; content: string } | null>(null);
  const [textError, setTextError] = useState<string | null>(null);

  const groups: DocumentGroup[] = groupDocuments(data ?? []);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setNotice(null);
      upload.mutate(file);
    }
    // 允許連續上傳同一檔名
    e.target.value = "";
  }

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function submitText() {
    if (!textDraft) return;
    setTextError(null);
    try {
      await createText.mutateAsync({ content: textDraft.content, title: textDraft.title });
      setTextDraft(null);
    } catch (e) {
      setTextError(e instanceof Error ? e.message : t("knowledge.manage.saveError"));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("knowledge.manage.uploadHint")}</p>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            className="hidden"
            onChange={onPick}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            {upload.isPending ? t("knowledge.manage.uploading") : t("knowledge.manage.uploadFile")}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setTextError(null);
              setTextDraft({ title: "", content: "" });
            }}
          >
            <Plus className="h-4 w-4" /> {t("knowledge.manage.addText")}
          </Button>
        </div>
      </div>

      {notice && (
        <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          {notice}
        </div>
      )}
      {banner && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t("knowledge.manage.uploadError", { msg: banner })}
        </div>
      )}

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : isError ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-sm text-destructive">
              {t("knowledge.manage.docsLoadError")}
              {error instanceof Error ? `:${error.message}` : ""}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {t("knowledge.manage.retry")}
            </Button>
          </CardContent>
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("knowledge.manage.docsEmpty")}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => {
            const total = g.chunks.length;
            const fullyEmbedded = g.embeddedCount === total;
            const isOpen = expanded.has(g.key);
            return (
              <Card key={g.key}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => toggle(g.key)}
                      className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    >
                      {isOpen ? (
                        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{g.name}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{t("knowledge.manage.chunkCount", { n: total })}</span>
                          <Badge variant={fullyEmbedded ? "success" : "warning"} className="gap-1">
                            {fullyEmbedded
                              ? t("knowledge.manage.embeddedYes")
                              : t("knowledge.manage.embeddedCount", {
                                  done: g.embeddedCount,
                                  total,
                                })}
                          </Badge>
                        </div>
                      </div>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-destructive hover:text-destructive"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (confirm(t("knowledge.manage.confirmDeleteDoc", { name: g.name, n: total })))
                          remove.mutate(g.chunks.map((c) => c.id));
                      }}
                      aria-label={t("knowledge.manage.deleteDoc")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  {isOpen && (
                    <div className="mt-3 space-y-2 border-t border-border pt-3">
                      {g.chunks.map((c) => (
                        <div key={c.id} className="rounded-md bg-muted/50 p-2">
                          <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                            {t("knowledge.manage.chunkLabel", { i: c.chunk_index + 1 })}
                          </p>
                          <p className="whitespace-pre-wrap text-xs">{c.content}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!textDraft} onOpenChange={(v) => !v && setTextDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("knowledge.manage.addTextTitle")}</DialogTitle>
            <DialogDescription>{t("knowledge.manage.addTextDesc")}</DialogDescription>
          </DialogHeader>
          {textDraft && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="doc-title">{t("knowledge.manage.docTitleLabel")}</Label>
                <Input
                  id="doc-title"
                  value={textDraft.title}
                  onChange={(e) => setTextDraft({ ...textDraft, title: e.target.value })}
                  placeholder={t("knowledge.manage.docTitlePlaceholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="doc-content">{t("knowledge.manage.docContentLabel")}</Label>
                <Textarea
                  id="doc-content"
                  value={textDraft.content}
                  onChange={(e) => setTextDraft({ ...textDraft, content: e.target.value })}
                  placeholder={t("knowledge.manage.docContentPlaceholder")}
                  className="min-h-[160px]"
                />
              </div>
              {textError && <p className="text-xs text-destructive">{textError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTextDraft(null)}>
              {t("knowledge.manage.cancel")}
            </Button>
            <Button
              onClick={submitText}
              disabled={createText.isPending || !textDraft?.content.trim()}
            >
              {createText.isPending ? t("knowledge.manage.saving") : t("knowledge.manage.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
