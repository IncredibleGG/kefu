import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock, Plus, Trash2 } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/api/client";
import { iamApi } from "@/api/endpoints";
import { schedulingApi, type ShiftInput } from "@/api/scheduling";

/* ------------------------------ 常數 / 工具 ------------------------------ */
const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

// 0=週一 … 6=週日,對齊後端 weekday。
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const DEFAULT_START = "09:00";
const DEFAULT_END = "18:00";

/** 分鐘(0-1440)→ "HH:MM"。 */
function minToHHMM(m: number): string {
  const clamped = Math.max(0, Math.min(1440, m));
  const h = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** "HH:MM" → 分鐘(0-1440);非法回 NaN。 */
function hhmmToMin(s: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!match) return NaN;
  const h = Number(match[1]);
  const mm = Number(match[2]);
  if (h > 24 || mm > 59) return NaN;
  const total = h * 60 + mm;
  return total > 1440 ? NaN : total;
}

/** 單一上線時段(時間以 HH:MM 字串保存,送出時換算分鐘)。 */
interface Segment {
  /** React list 穩定 key(僅前端用,不送後端)。 */
  id: string;
  start: string;
  end: string;
}
/** 單日班表:一天可有多個時段(對齊後端 staff_shift 每日可多筆)。 */
interface DayRow {
  weekday: number;
  enabled: boolean;
  segments: Segment[];
}

let segSeq = 0;
/** 產生帶穩定 id 的時段。 */
function newSegment(start = DEFAULT_START, end = DEFAULT_END): Segment {
  segSeq += 1;
  return { id: `seg-${segSeq}`, start, end };
}

function blankRows(): DayRow[] {
  return WEEKDAYS.map((w) => ({
    weekday: w,
    enabled: false,
    segments: [newSegment()],
  }));
}

/* ================================ 頁面 ================================ */
/** 坐席排班設定:選坐席 → 逐日設定上線時段 → 儲存(整組覆寫)。
 *  由 SettingsPage 以 ?tab=schedule 掛載;自帶 PageShell。 */
export function ScheduleSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const weekdayLabels = useMemo(
    () => [
      t("schedule.weekday.mon", { defaultValue: "週一" }),
      t("schedule.weekday.tue", { defaultValue: "週二" }),
      t("schedule.weekday.wed", { defaultValue: "週三" }),
      t("schedule.weekday.thu", { defaultValue: "週四" }),
      t("schedule.weekday.fri", { defaultValue: "週五" }),
      t("schedule.weekday.sat", { defaultValue: "週六" }),
      t("schedule.weekday.sun", { defaultValue: "週日" }),
    ],
    [t],
  );

  const [selectedStaffId, setSelectedStaffId] = useState<string>("");
  const [rows, setRows] = useState<DayRow[]>(blankRows());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // 坐席清單(只讀既有 iamApi.staff)
  const staffQuery = useQuery({
    queryKey: ["iam", "staff", "lite"],
    queryFn: () => iamApi.staff(),
  });
  const staffList = staffQuery.data ?? [];

  // 目前在班坐席(權威來源:伺服器時間判斷)
  const onShiftQuery = useQuery({
    queryKey: ["scheduling", "on-shift"],
    queryFn: () => schedulingApi.onShift(),
    refetchInterval: 60_000,
  });
  const onShiftIds = useMemo(() => new Set(onShiftQuery.data ?? []), [onShiftQuery.data]);

  // 選定坐席的班表
  const shiftsQuery = useQuery({
    queryKey: ["scheduling", "shifts", selectedStaffId],
    queryFn: () => schedulingApi.listShifts(selectedStaffId),
    enabled: !!selectedStaffId,
  });

  // 坐席載入後:預設選第一位
  useEffect(() => {
    if (!selectedStaffId && staffList.length > 0) {
      setSelectedStaffId(staffList[0].id);
    }
  }, [staffList, selectedStaffId]);

  // 班表載入後:回填 7 日表單(同日多筆時段全數還原,依開始時間排序)
  useEffect(() => {
    if (!selectedStaffId) return;
    const data = shiftsQuery.data;
    if (data === undefined) return; // 尚未載入完成
    const byDay = new Map<number, typeof data>();
    for (const s of data) {
      if (s.weekday < 0 || s.weekday > 6) continue;
      if (!s.enabled) continue; // 僅還原啟用時段(與儲存契約一致)
      const arr = byDay.get(s.weekday) ?? [];
      arr.push(s);
      byDay.set(s.weekday, arr);
    }
    const next: DayRow[] = WEEKDAYS.map((w) => {
      const arr = (byDay.get(w) ?? []).slice().sort((a, b) => a.start_minute - b.start_minute);
      if (arr.length === 0) return { weekday: w, enabled: false, segments: [newSegment()] };
      return {
        weekday: w,
        enabled: true,
        segments: arr.map((s) => newSegment(minToHHMM(s.start_minute), minToHHMM(s.end_minute))),
      };
    });
    setRows(next);
    setError(null);
    setSaved(false);
  }, [shiftsQuery.data, selectedStaffId]);

  function setDayEnabled(weekday: number, enabled: boolean) {
    setRows((prev) =>
      prev.map((r) =>
        r.weekday === weekday
          ? { ...r, enabled, segments: r.segments.length ? r.segments : [newSegment()] }
          : r,
      ),
    );
    setSaved(false);
  }

  function updateSegment(weekday: number, id: string, patch: Partial<Segment>) {
    setRows((prev) =>
      prev.map((r) =>
        r.weekday === weekday
          ? { ...r, segments: r.segments.map((s) => (s.id === id ? { ...s, ...patch } : s)) }
          : r,
      ),
    );
    setSaved(false);
  }

  function addSegment(weekday: number) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.weekday !== weekday) return r;
        // 新時段預設接在最後一段之後,避免預設就重疊
        const last = r.segments[r.segments.length - 1];
        const lastEnd = last ? hhmmToMin(last.end) : NaN;
        let startMin = Number.isFinite(lastEnd) && lastEnd < 1440 ? lastEnd : hhmmToMin(DEFAULT_START);
        let endMin = Math.min(1440, startMin + 60);
        if (endMin <= startMin) {
          startMin = hhmmToMin(DEFAULT_START);
          endMin = hhmmToMin(DEFAULT_END);
        }
        const seg = newSegment(minToHHMM(startMin), minToHHMM(endMin));
        return { ...r, enabled: true, segments: [...r.segments, seg] };
      }),
    );
    setSaved(false);
  }

  function removeSegment(weekday: number, id: string) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.weekday !== weekday) return r;
        const segments = r.segments.filter((s) => s.id !== id);
        // 一天至少保留一段(刪光時補一預設段,維持可再啟用)
        return { ...r, segments: segments.length ? segments : [newSegment()] };
      }),
    );
    setSaved(false);
  }

  /** 前端驗證:各啟用日的時段須 start<end 且互不重疊;回傳首個錯誤訊息或 null。 */
  function validateRows(): string | null {
    for (const r of rows) {
      if (!r.enabled) continue;
      const segs = r.segments.map((s) => ({ start: hhmmToMin(s.start), end: hhmmToMin(s.end) }));
      for (const seg of segs) {
        if (Number.isNaN(seg.start) || Number.isNaN(seg.end) || seg.start >= seg.end) {
          return t("schedule.error.invalidRange", {
            defaultValue: "{{day}} 的時段時間不正確:結束需晚於開始",
            day: weekdayLabels[r.weekday],
          });
        }
      }
      const sorted = segs.slice().sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i].start < sorted[i - 1].end) {
          return t("schedule.error.overlap", {
            defaultValue: "{{day}} 的時段有重疊,請調整後再儲存",
            day: weekdayLabels[r.weekday],
          });
        }
      }
    }
    return null;
  }

  const selectedStaff = staffList.find((s) => s.id === selectedStaffId) ?? null;
  const selectedOnShift = !!selectedStaffId && onShiftIds.has(selectedStaffId);

  const saveMut = useMutation({
    mutationFn: async () => {
      // 前端整體驗證(range + 不重疊);任一天不合法即中止
      const invalid = validateRows();
      if (invalid) throw new Error(invalid);
      // 把所有天的所有時段一起送(後端 PUT 為整組覆寫)
      const shifts: ShiftInput[] = [];
      for (const r of rows) {
        if (!r.enabled) continue; // 僅送啟用的日子
        for (const seg of r.segments) {
          shifts.push({
            weekday: r.weekday,
            start_minute: hhmmToMin(seg.start),
            end_minute: hhmmToMin(seg.end),
            enabled: true,
          });
        }
      }
      return schedulingApi.setStaffShifts(selectedStaffId, shifts);
    },
    onSuccess: () => {
      setSaved(true);
      setError(null);
      qc.invalidateQueries({ queryKey: ["scheduling", "shifts", selectedStaffId] });
      qc.invalidateQueries({ queryKey: ["scheduling", "on-shift"] });
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "STAFF_NOT_FOUND") {
        setError(t("schedule.error.staffNotFound", { defaultValue: "坐席不存在或不屬本租戶" }));
      } else if (e instanceof ApiError && (e.httpStatus === 403 || e.code === "UNKNOWN")) {
        setError(
          t("schedule.error.forbidden", { defaultValue: "沒有權限修改班表(需要 staff.manage)" }),
        );
      } else {
        setError(
          e instanceof Error
            ? e.message
            : t("schedule.error.save", { defaultValue: "儲存失敗,請稍後再試" }),
        );
      }
    },
  });

  function submit() {
    setError(null);
    if (!selectedStaffId) {
      setError(t("schedule.error.noStaff", { defaultValue: "請先選擇坐席" }));
      return;
    }
    const invalid = validateRows();
    if (invalid) {
      setError(invalid);
      return;
    }
    saveMut.mutate();
  }

  /* --------------------------------- render --------------------------------- */
  return (
    <PageShell
      title={t("schedule.title", { defaultValue: "坐席排班" })}
      description={t("schedule.description", {
        defaultValue: "為每位坐席設定每週的上線時段;系統據此判斷「目前在班」。",
      })}
    >
      {staffQuery.isLoading ? (
        <Skeleton className="h-96 max-w-2xl" />
      ) : staffQuery.isError ? (
        <Card className="max-w-2xl">
          <CardContent className="py-8">
            <p className="text-sm text-destructive">
              {t("schedule.error.loadStaff", { defaultValue: "載入坐席清單失敗,請稍後再試" })}
            </p>
          </CardContent>
        </Card>
      ) : staffList.length === 0 ? (
        <Card className="max-w-2xl">
          <CardContent className="py-8">
            <p className="text-sm text-muted-foreground">
              {t("schedule.emptyStaff", { defaultValue: "尚無坐席可排班,請先於「坐席」建立坐席。" })}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="max-w-2xl space-y-4">
          {/* 選坐席 + 在班標記 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                {t("schedule.pickStaff", { defaultValue: "選擇坐席" })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <select
                  className={`${SELECT_CLS} max-w-xs`}
                  value={selectedStaffId}
                  onChange={(e) => setSelectedStaffId(e.target.value)}
                  aria-label={t("schedule.pickStaff", { defaultValue: "選擇坐席" })}
                >
                  {staffList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name}
                      {onShiftIds.has(s.id)
                        ? ` · ${t("schedule.onShiftShort", { defaultValue: "在班" })}`
                        : ""}
                    </option>
                  ))}
                </select>
                {selectedStaff && (
                  <Badge variant={selectedOnShift ? "default" : "secondary"} className="gap-1">
                    <Clock className="h-3 w-3" />
                    {selectedOnShift
                      ? t("schedule.onShift", { defaultValue: "目前在班" })
                      : t("schedule.offShift", { defaultValue: "目前不在班" })}
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("schedule.onShiftHint", {
                  defaultValue: "「在班」依伺服器時間與下方班表即時判斷,每分鐘自動更新。",
                })}
              </p>
            </CardContent>
          </Card>

          {/* 每週班表編輯 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                {t("schedule.weeklyTitle", { defaultValue: "每週上線時段" })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {selectedStaffId && shiftsQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 7 }).map((_, i) => (
                    <Skeleton key={i} className="h-11 w-full" />
                  ))}
                </div>
              ) : selectedStaffId && shiftsQuery.isError ? (
                <p className="text-sm text-destructive">
                  {t("schedule.error.loadShifts", { defaultValue: "載入班表失敗,請稍後再試" })}
                </p>
              ) : (
                <>
                  <ul className="space-y-2">
                    {rows.map((r) => (
                      <li key={r.weekday} className="rounded-md border border-border p-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={r.enabled}
                              onCheckedChange={(v) => setDayEnabled(r.weekday, v)}
                              aria-label={weekdayLabels[r.weekday]}
                            />
                            <span className="text-sm font-medium">{weekdayLabels[r.weekday]}</span>
                          </div>
                          {r.enabled ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="gap-1"
                              onClick={() => addSegment(r.weekday)}
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {t("schedule.addSegment", { defaultValue: "新增時段" })}
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {t("schedule.dayOff", { defaultValue: "休息" })}
                            </span>
                          )}
                        </div>
                        {r.enabled && (
                          <ul className="mt-2 space-y-2 pl-1">
                            {r.segments.map((seg) => (
                              <li key={seg.id} className="flex flex-wrap items-center gap-2">
                                <Label
                                  htmlFor={`start-${r.weekday}-${seg.id}`}
                                  className="text-xs text-muted-foreground"
                                >
                                  {t("schedule.from", { defaultValue: "自" })}
                                </Label>
                                <Input
                                  id={`start-${r.weekday}-${seg.id}`}
                                  type="time"
                                  value={seg.start}
                                  onChange={(e) => updateSegment(r.weekday, seg.id, { start: e.target.value })}
                                  className="w-32"
                                />
                                <Label
                                  htmlFor={`end-${r.weekday}-${seg.id}`}
                                  className="text-xs text-muted-foreground"
                                >
                                  {t("schedule.to", { defaultValue: "至" })}
                                </Label>
                                <Input
                                  id={`end-${r.weekday}-${seg.id}`}
                                  type="time"
                                  value={seg.end}
                                  onChange={(e) => updateSegment(r.weekday, seg.id, { end: e.target.value })}
                                  className="w-32"
                                />
                                {r.segments.length > 1 && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="text-muted-foreground hover:text-destructive"
                                    onClick={() => removeSegment(r.weekday, seg.id)}
                                    aria-label={t("schedule.removeSegment", { defaultValue: "刪除時段" })}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>

                  {error && <p className="text-sm text-destructive">{error}</p>}

                  <div className="flex items-center gap-2 pt-1">
                    <Button onClick={submit} disabled={saveMut.isPending || !selectedStaffId}>
                      {saveMut.isPending
                        ? t("schedule.saving", { defaultValue: "儲存中…" })
                        : t("schedule.save", { defaultValue: "儲存班表" })}
                    </Button>
                    {saved && (
                      <span className="flex items-center gap-1 text-xs text-success">
                        <Check className="h-3.5 w-3.5" />{" "}
                        {t("schedule.saved", { defaultValue: "已儲存" })}
                      </span>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </PageShell>
  );
}
