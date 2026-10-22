import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Clock, MessageSquare, Palette, Check, ClipboardList, Star } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useTenantSettings } from "@/api/hooks";
import { settingsApi } from "@/api/endpoints";
import { cn } from "@/lib/utils";
import { fileUrl } from "@/lib/server";
import type { BusinessHours, PrechatField, TenantSettings, WidgetTheme } from "@/types";

const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const WEEKDAYS: { key: string; label: string }[] = [
  { key: "mon", label: "config.widget.weekday.mon" },
  { key: "tue", label: "config.widget.weekday.tue" },
  { key: "wed", label: "config.widget.weekday.wed" },
  { key: "thu", label: "config.widget.weekday.thu" },
  { key: "fri", label: "config.widget.weekday.fri" },
  { key: "sat", label: "config.widget.weekday.sat" },
  { key: "sun", label: "config.widget.weekday.sun" },
];

const TIMEZONES = [
  "Asia/Taipei",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "UTC",
];

type DayState = { enabled: boolean; start: string; end: string };

/** 內建 eye-catcher 圖形樣式鍵(須與 widget/src/widget.ts 的 EYECATCHER_SHAPES 對齊)。
 *  空字串 = 不用內建圖形(退回圖片 URL 或純文字)。 */
const EYE_CATCHER_STYLES: { value: string; labelKey: string; labelDefault: string }[] = [
  { value: "", labelKey: "config.widget.eyeCatcherStyleNone", labelDefault: "無(純文字)" },
  { value: "wave", labelKey: "config.widget.eyeCatcherStyleWave", labelDefault: "揮手 👋" },
  { value: "chat", labelKey: "config.widget.eyeCatcherStyleChat", labelDefault: "對話泡泡 💬" },
  { value: "bell", labelKey: "config.widget.eyeCatcherStyleBell", labelDefault: "鈴鐺 🔔" },
  { value: "gift", labelKey: "config.widget.eyeCatcherStyleGift", labelDefault: "禮物 🎁" },
  { value: "help", labelKey: "config.widget.eyeCatcherStyleHelp", labelDefault: "求助 ❓" },
];

/** post-chat 問卷欄位型別(對齊 widget 端 SurveyField)。 */
type SurveyFieldType = "rating" | "text" | "email" | "choice";
interface SurveyField {
  key: string;
  label: string;
  type: SurveyFieldType;
  options?: string[];
  required?: boolean;
}
interface PostChatSurvey {
  enabled: boolean;
  fields: SurveyField[];
}

/** widget_theme 為 JSONB 原樣存讀,故以區域擴充型別攜帶新欄位(不需改型別檔 / 後端 model)。 */
type WidgetThemePlus = WidgetTheme & {
  eye_catcher?: string;
  eye_catcher_image?: string;
  eye_catcher_style?: string;
  post_chat_survey?: PostChatSurvey;
};

function toDayStates(bh: BusinessHours | null): Record<string, DayState> {
  const out: Record<string, DayState> = {};
  for (const { key } of WEEKDAYS) {
    const ranges = bh?.days?.[key];
    const first = ranges && ranges[0];
    out[key] = first
      ? { enabled: true, start: first[0], end: first[1] }
      : { enabled: false, start: "09:00", end: "18:00" };
  }
  return out;
}

export function WidgetSettingsPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useTenantSettings();
  const qc = useQueryClient();

  const [tz, setTz] = useState("Asia/Taipei");
  const [days, setDays] = useState<Record<string, DayState>>(() => toDayStates(null));
  const [offline, setOffline] = useState("");
  const [prechatEnabled, setPrechatEnabled] = useState(false);
  const [fields, setFields] = useState<PrechatField[]>([]);
  // WidgetTheme(types)尚無 eye_catcher / 問卷等欄;皆存進同一 widget_theme config,
  // 後端以 JSONB 原樣存讀,故以區域擴充型別攜帶(不需改型別檔 / 後端 model)。
  const [theme, setTheme] = useState<WidgetThemePlus>({
    primary_color: "#4f46e5",
    logo_url: "",
    greeting: "",
    eye_catcher: "",
    eye_catcher_image: "",
    eye_catcher_style: "",
  });
  // post-chat 問卷(存 widget_theme.post_chat_survey);另置 state 便於編輯,save 時併入 widget_theme。
  const [postChatEnabled, setPostChatEnabled] = useState(false);
  const [surveyFields, setSurveyFields] = useState<SurveyField[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 載入後填入表單
  useEffect(() => {
    if (!data) return;
    setTz(data.timezone || data.business_hours?.timezone || "Asia/Taipei");
    setDays(toDayStates(data.business_hours));
    setOffline(data.offline_message ?? "");
    setPrechatEnabled(!!data.prechat_enabled);
    setFields(data.prechat_fields ?? []);
    const wt = (data.widget_theme as WidgetThemePlus | null | undefined) ?? null;
    setTheme({
      primary_color: wt?.primary_color || "#4f46e5",
      logo_url: wt?.logo_url || "",
      greeting: wt?.greeting || "",
      eye_catcher: wt?.eye_catcher || "",
      eye_catcher_image: wt?.eye_catcher_image || "",
      eye_catcher_style: wt?.eye_catcher_style || "",
    });
    const survey = wt?.post_chat_survey;
    setPostChatEnabled(!!survey?.enabled);
    setSurveyFields(Array.isArray(survey?.fields) ? survey.fields : []);
  }, [data]);

  function addField() {
    setFields([...fields, { key: `field_${fields.length + 1}`, label: "", type: "text", required: false }]);
  }
  function updateField(i: number, patch: Partial<PrechatField>) {
    setFields(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function removeField(i: number) {
    setFields(fields.filter((_, idx) => idx !== i));
  }

  // post-chat 問卷欄位增刪改(對齊 pre-chat 欄位 helper)
  function addSurveyField() {
    setSurveyFields([
      ...surveyFields,
      { key: `q_${surveyFields.length + 1}`, label: "", type: "rating", required: false },
    ]);
  }
  function updateSurveyField(i: number, patch: Partial<SurveyField>) {
    setSurveyFields(surveyFields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function removeSurveyField(i: number) {
    setSurveyFields(surveyFields.filter((_, idx) => idx !== i));
  }
  /** choice 選項:以逗號 / 換行分隔的字串 ↔ 陣列。 */
  function parseOptions(raw: string): string[] {
    return raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const business_hours: BusinessHours = {
        timezone: tz,
        days: Object.fromEntries(
          WEEKDAYS.map(({ key }) => {
            const d = days[key];
            return [key, d.enabled ? [[d.start, d.end]] : []];
          }),
        ),
      };
      // 併入 post-chat 問卷到 widget_theme(JSONB 原樣存);停用且無欄位時仍存 {enabled:false},
      // widget 端 getPostChatSurvey 於未啟用時回 null → 退回固定 CSAT(零回歸)。
      const widget_theme: WidgetThemePlus = {
        ...theme,
        post_chat_survey: { enabled: postChatEnabled, fields: surveyFields },
      };
      const body: Partial<TenantSettings> = {
        business_hours,
        timezone: tz,
        offline_message: offline || null,
        prechat_enabled: prechatEnabled,
        prechat_fields: fields,
        widget_theme,
      };
      await settingsApi.update(body);
      await qc.invalidateQueries({ queryKey: ["tenantSettings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("config.common.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <PageShell title={t("config.widget.title")}>
        <Skeleton className="h-96 w-full" />
      </PageShell>
    );
  }

  return (
    <PageShell
      title={t("config.widget.title")}
      description={t("config.widget.description")}
      actions={
        <div className="flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> {t("config.common.saved")}
            </span>
          )}
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? t("config.common.saving") : t("config.widget.saveAll")}
          </Button>
        </div>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* 營業時間 */}
          <Card>
            <CardHeader className="flex-row items-center gap-2">
              <Clock className="h-4 w-4 text-brand" />
              <CardTitle className="text-sm">{t("config.widget.businessHours")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                <Label className="w-16 shrink-0">{t("config.widget.timezone")}</Label>
                <select className={cn(SELECT_CLS, "max-w-xs")} value={tz} onChange={(e) => setTz(e.target.value)}>
                  {TIMEZONES.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </div>
              <Separator />
              <div className="space-y-2">
                {WEEKDAYS.map(({ key, label }) => {
                  const d = days[key];
                  return (
                    <div key={key} className="flex items-center gap-3">
                      <div className="flex w-24 items-center gap-2">
                        <Switch
                          checked={d.enabled}
                          onCheckedChange={(v) => setDays({ ...days, [key]: { ...d, enabled: v } })}
                        />
                        <span className="text-sm">{t(label)}</span>
                      </div>
                      {d.enabled ? (
                        <div className="flex items-center gap-2">
                          <Input
                            type="time"
                            value={d.start}
                            onChange={(e) => setDays({ ...days, [key]: { ...d, start: e.target.value } })}
                            className="h-8 w-28"
                          />
                          <span className="text-muted-foreground">{t("config.widget.to")}</span>
                          <Input
                            type="time"
                            value={d.end}
                            onChange={(e) => setDays({ ...days, [key]: { ...d, end: e.target.value } })}
                            className="h-8 w-28"
                          />
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("config.widget.dayOff")}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">{t("config.widget.crossMidnightHint")}</p>
            </CardContent>
          </Card>

          {/* 離線訊息 */}
          <Card>
            <CardHeader className="flex-row items-center gap-2">
              <MessageSquare className="h-4 w-4 text-brand" />
              <CardTitle className="text-sm">{t("config.widget.offlineMessage")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={offline}
                onChange={(e) => setOffline(e.target.value)}
                placeholder={t("config.widget.offlinePlaceholder")}
                className="min-h-[80px]"
              />
            </CardContent>
          </Card>

          {/* pre-chat 表單 */}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-brand" />
                <CardTitle className="text-sm">{t("config.widget.prechatTitle")}</CardTitle>
              </div>
              <Switch checked={prechatEnabled} onCheckedChange={setPrechatEnabled} />
            </CardHeader>
            <CardContent className="space-y-3">
              {!prechatEnabled ? (
                <p className="text-xs text-muted-foreground">{t("config.widget.prechatDisabledHint")}</p>
              ) : (
                <>
                  {fields.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t("config.widget.prechatNoFields")}</p>
                  )}
                  {fields.map((f, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                      <Input
                        value={f.label}
                        onChange={(e) => updateField(i, { label: e.target.value })}
                        placeholder={t("config.widget.fieldLabelPlaceholder")}
                        className="h-8 w-40"
                      />
                      <Input
                        value={f.key}
                        onChange={(e) => updateField(i, { key: e.target.value.replace(/\s/g, "") })}
                        placeholder="key"
                        className="h-8 w-32 font-mono text-xs"
                      />
                      <select
                        className={cn(SELECT_CLS, "h-8 w-28")}
                        value={f.type}
                        onChange={(e) => updateField(i, { type: e.target.value as PrechatField["type"] })}
                      >
                        <option value="text">{t("config.widget.fieldType.text")}</option>
                        <option value="email">Email</option>
                        <option value="tel">{t("config.widget.fieldType.tel")}</option>
                        <option value="textarea">{t("config.widget.fieldType.textarea")}</option>
                      </select>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch checked={f.required} onCheckedChange={(v) => updateField(i, { required: v })} />
                        {t("config.widget.required")}
                      </label>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeField(i)}
                        className="ml-auto text-destructive hover:text-destructive"
                        aria-label={t("config.widget.removeField")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={addField}>
                    <Plus className="h-4 w-4" /> {t("config.widget.addField")}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* post-chat 問卷:會話結束時取代固定 CSAT(未啟用 / 無欄位則退回固定 CSAT) */}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <Star className="h-4 w-4 text-brand" />
                <CardTitle className="text-sm">
                  {t("config.widget.postChatTitle", { defaultValue: "結束問卷(Post-chat)" })}
                </CardTitle>
              </div>
              <Switch checked={postChatEnabled} onCheckedChange={setPostChatEnabled} />
            </CardHeader>
            <CardContent className="space-y-3">
              {!postChatEnabled ? (
                <p className="text-xs text-muted-foreground">
                  {t("config.widget.postChatDisabledHint", {
                    defaultValue: "停用時,會話結束沿用固定的滿意度評分(評分 + 留言)。",
                  })}
                </p>
              ) : (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    {t("config.widget.postChatHint", {
                      defaultValue: "會話結束時向訪客顯示自訂問卷。含評分欄時走既有 CSAT 送出(其餘欄位併入回饋);無評分欄時以結構化訊息收集。",
                    })}
                  </p>
                  {surveyFields.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("config.widget.postChatNoFields", { defaultValue: "尚未新增問卷欄位。" })}
                    </p>
                  )}
                  {surveyFields.map((f, i) => (
                    <div key={i} className="space-y-2 rounded-md border border-border p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          value={f.label}
                          onChange={(e) => updateSurveyField(i, { label: e.target.value })}
                          placeholder={t("config.widget.fieldLabelPlaceholder")}
                          className="h-8 w-40"
                        />
                        <Input
                          value={f.key}
                          onChange={(e) => updateSurveyField(i, { key: e.target.value.replace(/\s/g, "") })}
                          placeholder="key"
                          className="h-8 w-28 font-mono text-xs"
                        />
                        <select
                          className={cn(SELECT_CLS, "h-8 w-28")}
                          value={f.type}
                          onChange={(e) => updateSurveyField(i, { type: e.target.value as SurveyFieldType })}
                        >
                          <option value="rating">{t("config.widget.surveyType.rating", { defaultValue: "評分" })}</option>
                          <option value="text">{t("config.widget.fieldType.text")}</option>
                          <option value="email">Email</option>
                          <option value="choice">{t("config.widget.surveyType.choice", { defaultValue: "單選" })}</option>
                        </select>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Switch
                            checked={!!f.required}
                            onCheckedChange={(v) => updateSurveyField(i, { required: v })}
                          />
                          {t("config.widget.required")}
                        </label>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => removeSurveyField(i)}
                          className="ml-auto text-destructive hover:text-destructive"
                          aria-label={t("config.widget.removeField")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      {f.type === "choice" && (
                        <Input
                          value={(f.options ?? []).join(", ")}
                          onChange={(e) => updateSurveyField(i, { options: parseOptions(e.target.value) })}
                          placeholder={t("config.widget.surveyOptionsPlaceholder", {
                            defaultValue: "選項,以逗號分隔(例:很好, 普通, 待改進)",
                          })}
                          className="h-8 text-xs"
                        />
                      )}
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={addSurveyField}>
                    <Plus className="h-4 w-4" /> {t("config.widget.addSurveyField", { defaultValue: "新增問卷欄位" })}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* 外觀 */}
          <Card>
            <CardHeader className="flex-row items-center gap-2">
              <Palette className="h-4 w-4 text-brand" />
              <CardTitle className="text-sm">{t("config.widget.appearance")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label>{t("config.widget.primaryColor")}</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={theme.primary_color}
                    onChange={(e) => setTheme({ ...theme, primary_color: e.target.value })}
                    className="h-9 w-12 cursor-pointer rounded-md border border-input bg-transparent"
                    aria-label={t("config.widget.primaryColor")}
                  />
                  <Input
                    value={theme.primary_color}
                    onChange={(e) => setTheme({ ...theme, primary_color: e.target.value })}
                    className="w-32 font-mono text-xs"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="logo">Logo URL</Label>
                <Input
                  id="logo"
                  value={theme.logo_url}
                  onChange={(e) => setTheme({ ...theme, logo_url: e.target.value })}
                  placeholder="https://…/logo.png"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="greeting">{t("config.widget.greeting")}</Label>
                <Input
                  id="greeting"
                  value={theme.greeting}
                  onChange={(e) => setTheme({ ...theme, greeting: e.target.value })}
                  placeholder={t("config.widget.greetingPlaceholder")}
                />
              </div>
              {/* eye-catcher 誘餌:啟動氣泡旁的招攬小氣泡文字(未開面板時顯示,點擊開面板) */}
              <div className="space-y-1.5">
                <Label htmlFor="eye-catcher">
                  {t("config.widget.eyeCatcher", { defaultValue: "誘餌訊息(Eye-catcher)" })}
                </Label>
                <Input
                  id="eye-catcher"
                  value={theme.eye_catcher}
                  onChange={(e) => setTheme({ ...theme, eye_catcher: e.target.value })}
                  placeholder={t("config.widget.eyeCatcherPlaceholder", { defaultValue: "有任何問題嗎?點我聊聊 👋" })}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t("config.widget.eyeCatcherHint", {
                    defaultValue: "顯示在啟動氣泡旁的小氣泡,吸引訪客開啟對話;留空則不顯示。",
                  })}
                </p>
              </div>
              {/* eye-catcher 圖形樣式:內建描邊 SVG(隨主色);與文字並存,圖片優先於內建圖形 */}
              <div className="space-y-1.5">
                <Label htmlFor="eye-catcher-style">
                  {t("config.widget.eyeCatcherStyle", { defaultValue: "誘餌圖形樣式" })}
                </Label>
                <select
                  id="eye-catcher-style"
                  className={cn(SELECT_CLS, "max-w-xs")}
                  value={theme.eye_catcher_style || ""}
                  onChange={(e) => setTheme({ ...theme, eye_catcher_style: e.target.value })}
                >
                  {EYE_CATCHER_STYLES.map((s) => (
                    <option key={s.value || "none"} value={s.value}>
                      {t(s.labelKey, { defaultValue: s.labelDefault })}
                    </option>
                  ))}
                </select>
              </div>
              {/* eye-catcher 圖片 URL:優先於內建圖形;先驗 http(s):// */}
              <div className="space-y-1.5">
                <Label htmlFor="eye-catcher-image">
                  {t("config.widget.eyeCatcherImage", { defaultValue: "誘餌圖片 URL(選填)" })}
                </Label>
                <Input
                  id="eye-catcher-image"
                  value={theme.eye_catcher_image || ""}
                  onChange={(e) => setTheme({ ...theme, eye_catcher_image: e.target.value })}
                  placeholder="https://…/eye-catcher.png"
                  className="font-mono text-xs"
                />
                {theme.eye_catcher_image && !/^https?:\/\//i.test(theme.eye_catcher_image.trim()) && (
                  <p className="text-[11px] font-medium text-destructive">
                    {t("config.widget.eyeCatcherImageInvalid", { defaultValue: "圖片 URL 需以 http(s):// 開頭" })}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {t("config.widget.eyeCatcherImageHint", {
                    defaultValue: "填入圖片將以圖片版誘餌呈現(優先於內建圖形);留空則用上方圖形樣式或純文字。",
                  })}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 即時預覽 */}
        <div className="lg:col-span-1">
          <div className="sticky top-0">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{t("config.widget.livePreview")}</p>
            <WidgetPreview theme={theme} />
          </div>
        </div>
      </div>
    </PageShell>
  );
}

function WidgetPreview({ theme }: { theme: WidgetTheme }) {
  const { t } = useTranslation();
  const color = theme.primary_color || "#4f46e5";
  return (
    <div className="overflow-hidden rounded-xl border border-border shadow-lg">
      <div className="flex items-center gap-2.5 px-4 py-3 text-white" style={{ backgroundColor: color }}>
        {theme.logo_url ? (
          <img src={fileUrl(theme.logo_url) ?? undefined} alt="logo" className="h-8 w-8 rounded-full bg-white/20 object-cover" />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-sm font-semibold">{t("config.widget.preview.avatar")}</div>
        )}
        <div>
          <p className="text-sm font-semibold">{t("config.widget.preview.title")}</p>
          <p className="text-[11px] opacity-80">{t("config.widget.preview.subtitle")}</p>
        </div>
      </div>
      <div className="space-y-2 bg-background p-4">
        <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm">
          {theme.greeting || t("config.widget.greetingPlaceholder")}
        </div>
        <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm px-3 py-2 text-sm text-white" style={{ backgroundColor: color }}>
          {t("config.widget.preview.sampleMsg")}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-border p-2.5">
        <div className="flex-1 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">{t("config.widget.preview.inputPlaceholder")}</div>
        <div className="flex h-8 w-8 items-center justify-center rounded-full text-white" style={{ backgroundColor: color }}>
          <MessageSquare className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}
