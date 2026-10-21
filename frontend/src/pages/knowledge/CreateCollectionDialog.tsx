import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  type KnowledgeSourceType,
} from "@/api/knowledgeContent";

const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const SOURCE_TYPES: { value: KnowledgeSourceType; labelKey: string }[] = [
  { value: "document", labelKey: "modules.knowledge.typeDocument" },
  { value: "qa", labelKey: "modules.knowledge.typeQa" },
  { value: "website", labelKey: "modules.knowledge.typeWebsite" },
];

export function CreateCollectionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<KnowledgeSourceType>("document");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => knowledgeContentApi.createCollection(name.trim(), sourceType),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: kkeys.collections });
      onOpenChange(false);
    },
    onError: (e) => setError(e instanceof Error ? e.message : t("knowledge.manage.saveError")),
  });

  function reset() {
    setName("");
    setSourceType("document");
    setError(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("knowledge.manage.createTitle")}</DialogTitle>
          <DialogDescription>{t("knowledge.manage.createDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="col-name">{t("knowledge.manage.nameLabel")}</Label>
            <Input
              id="col-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("knowledge.manage.namePlaceholder")}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="col-type">{t("knowledge.manage.sourceTypeLabel")}</Label>
            <select
              id="col-type"
              className={SELECT_CLS}
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as KnowledgeSourceType)}
            >
              {SOURCE_TYPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {t(s.labelKey)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t("knowledge.manage.sourceTypeHint")}</p>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("knowledge.manage.cancel")}
          </Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !name.trim()}>
            {create.isPending ? t("knowledge.manage.creating") : t("knowledge.manage.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
