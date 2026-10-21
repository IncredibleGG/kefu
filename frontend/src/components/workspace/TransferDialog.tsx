import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { User, Users, Undo2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { iamApi } from "@/api/endpoints";
import { initials, cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

type Mode = "staff" | "group" | "queue";
type Target =
  | { target_staff_id: string }
  | { target_skill_group_id: string }
  | Record<string, never>;

const statusDot: Record<string, string> = {
  online: "bg-status-online",
  busy: "bg-status-busy",
  away: "bg-status-away",
  offline: "bg-status-offline",
};

/** 轉接對話框:指定坐席 / 技能組 / 轉回佇列 + 選填備註。 */
export function TransferDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
  myStaffId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (target: Target, note?: string) => void;
  submitting?: boolean;
  myStaffId?: string;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("staff");
  const [selectedStaff, setSelectedStaff] = useState<string>();
  const [selectedGroup, setSelectedGroup] = useState<string>();
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");

  const staffQuery = useQuery({
    queryKey: ["iam", "staff"],
    queryFn: () => iamApi.staff(),
    enabled: open,
  });
  const groupQuery = useQuery({
    queryKey: ["iam", "skillGroups"],
    queryFn: () => iamApi.skillGroups(),
    enabled: open,
  });

  const staffList = (staffQuery.data ?? []).filter(
    (s) =>
      s.id !== myStaffId &&
      (!q || s.display_name?.toLowerCase().includes(q.toLowerCase()) || s.email?.toLowerCase().includes(q.toLowerCase())),
  );
  const groupList = groupQuery.data ?? [];

  const canSubmit =
    (mode === "staff" && !!selectedStaff) ||
    (mode === "group" && !!selectedGroup) ||
    mode === "queue";

  function submit() {
    if (mode === "staff" && selectedStaff) onSubmit({ target_staff_id: selectedStaff }, note || undefined);
    else if (mode === "group" && selectedGroup)
      onSubmit({ target_skill_group_id: selectedGroup }, note || undefined);
    else if (mode === "queue") onSubmit({}, note || undefined);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("workspace.transferDialog.title")}</DialogTitle>
          <DialogDescription>{t("workspace.transferDialog.description")}</DialogDescription>
        </DialogHeader>

        {/* 模式切換 */}
        <div className="flex gap-1.5">
          <ModeBtn active={mode === "staff"} onClick={() => setMode("staff")} icon={<User className="h-3.5 w-3.5" />}>
            {t("workspace.transferDialog.modeStaff")}
          </ModeBtn>
          <ModeBtn active={mode === "group"} onClick={() => setMode("group")} icon={<Users className="h-3.5 w-3.5" />}>
            {t("workspace.transferDialog.modeGroup")}
          </ModeBtn>
          <ModeBtn active={mode === "queue"} onClick={() => setMode("queue")} icon={<Undo2 className="h-3.5 w-3.5" />}>
            {t("workspace.transferDialog.modeQueue")}
          </ModeBtn>
        </div>

        {mode === "staff" && (
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("workspace.transferDialog.searchStaffPlaceholder")} className="h-8 pl-8" />
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {staffQuery.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : staffList.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">{t("workspace.transferDialog.noStaff")}</p>
              ) : (
                staffList.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedStaff(s.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                      selectedStaff === s.id
                        ? "border-brand bg-brand/8"
                        : "border-border hover:bg-accent",
                    )}
                  >
                    <Avatar className="h-7 w-7">
                      <AvatarFallback>{initials(s.display_name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <StatusDot className={statusDot[s.status ?? "offline"] ?? "bg-status-offline"} />
                        <span className="truncate text-sm font-medium">{s.display_name}</span>
                      </div>
                      {s.email && <p className="truncate text-[11px] text-muted-foreground">{s.email}</p>}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {mode === "group" && (
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {groupQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : groupList.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">{t("workspace.transferDialog.noGroups")}</p>
            ) : (
              groupList.map((g) => (
                <button
                  key={g.id}
                  onClick={() => setSelectedGroup(g.id)}
                  className={cn(
                    "flex w-full flex-col items-start rounded-md border px-2.5 py-1.5 text-left transition-colors",
                    selectedGroup === g.id ? "border-brand bg-brand/8" : "border-border hover:bg-accent",
                  )}
                >
                  <span className="text-sm font-medium">{g.name}</span>
                  {g.description && <span className="text-[11px] text-muted-foreground">{g.description}</span>}
                </button>
              ))
            )}
          </div>
        )}

        {mode === "queue" && (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {t("workspace.transferDialog.queueHint")}
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="transfer-note">{t("workspace.transferDialog.noteLabel")}</Label>
          <Textarea
            id="transfer-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("workspace.transferDialog.notePlaceholder")}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("workspace.cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit || submitting}>
            {t("workspace.transferDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
        active ? "border-brand bg-brand/10 text-brand" : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
