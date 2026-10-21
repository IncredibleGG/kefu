import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { iamApi } from "@/api/endpoints";
import { useAuth } from "@/stores/auth";
import { useNotify } from "@/stores/notify";
import { CannedPage } from "./CannedPage";
import { WidgetSettingsPage } from "./WidgetSettingsPage";
import { TranslationSettingsPage } from "./TranslationSettingsPage";
import { TagsSettingsPage } from "./TagsSettingsPage";
import { StaffSettingsPage } from "./StaffSettingsPage";
import { SkillsSettingsPage } from "./SkillsSettingsPage";
import { RbacSettingsPage } from "./RbacSettingsPage";
import { LlmSettingsPage } from "./LlmSettingsPage";
import { AutomationSettingsPage } from "./AutomationSettingsPage";
import { ProactiveSettingsPage } from "./ProactiveSettingsPage";
import { SlaSettingsPage } from "./SlaSettingsPage";
import { EmailChannelSettingsPage } from "./EmailChannelSettingsPage";
import { MetaChannelSettingsPage } from "./advanced/MetaChannelSettingsPage";
import { WebhookSettingsPage } from "./advanced/WebhookSettingsPage";
import { ApiKeySettingsPage } from "./advanced/ApiKeySettingsPage";
import { HelpCenterSettingsPage } from "./advanced/HelpCenterSettingsPage";
import { DomainsSettingsPage } from "./advanced/DomainsSettingsPage";
import { BrandSettings } from "./settings/BrandSettings";
import { MacrosSettingsPage } from "./settings/MacrosSettingsPage";
import { TwoFactorSettings } from "./settings/TwoFactorSettings";
import { ScheduleSettings } from "./settings/ScheduleSettings";
import { GoalsSettings } from "./settings/GoalsSettings";
import { IntegrationsSettings } from "./settings/IntegrationsSettings";
import { SecuritySettings } from "./settings/SecuritySettings";
import { SsoSettings } from "./settings/SsoSettings";
import { AuditPage } from "./AuditPage";

/** 簽名檔本機快取:後端 /auth/me 不回傳 signature,故以 localStorage(按 staff 分鍵)
 *  作為前端顯示與送訊附加的來源;儲存時同步寫入後端(iam updateStaff)與此快取。 */
export function signatureCacheKey(staffId: string): string {
  return `kefu-signature:${staffId}`;
}
function readSignatureCache(staffId: string): string {
  try {
    return localStorage.getItem(signatureCacheKey(staffId)) ?? "";
  } catch {
    return "";
  }
}
function writeSignatureCache(staffId: string, value: string): void {
  try {
    if (value) localStorage.setItem(signatureCacheKey(staffId), value);
    else localStorage.removeItem(signatureCacheKey(staffId));
  } catch {
    /* localStorage 不可用時略過 */
  }
}

export function SettingsPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const tab = params.get("tab") ?? "profile";
  const { staff, loadMe } = useAuth();
  const setSound = useNotify((s) => s.setSound);
  const [pwOpen, setPwOpen] = useState(false);

  // 個人資料表單(受控);以目前登入坐席初始化,staff 更換時重新播種
  const [seedId, setSeedId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [signature, setSignature] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (staff && staff.staff_id !== seedId) {
    setSeedId(staff.staff_id);
    setDisplayName(staff.display_name ?? "");
    // 簽名檔:優先讀本機快取,退回 /me 可能帶回的欄位(目前不帶,故多為快取)
    setSignature(
      readSignatureCache(staff.staff_id) ||
        ((staff as unknown as { signature?: string | null }).signature ?? ""),
    );
    setSoundOn(useNotify.getState().sound);
  }

  async function saveProfile() {
    if (!staff) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const name = displayName.trim();
      const nameChanged = !!name && name !== staff.display_name;
      // 簽名檔:與本機快取比較是否變更(尾端空白不視為有效內容)
      const sig = signature;
      const cachedSig = readSignatureCache(staff.staff_id);
      const sigChanged = sig !== cachedSig;

      if (nameChanged || sigChanged) {
        // signature 不在 updateStaff 的 TS body 型別內(endpoints.ts 不可改),
        // 故以 body 物件 + 型別轉換傳入;後端 iam.py 已接受並回傳 signature。
        const patch: Record<string, unknown> = {};
        if (nameChanged) patch.display_name = name;
        if (sigChanged) patch.signature = sig.trim() ? sig : null;
        const updated = await iamApi.updateStaff(
          staff.staff_id,
          patch as Parameters<typeof iamApi.updateStaff>[1],
        );
        if (sigChanged) {
          const persisted = (updated as unknown as { signature?: string | null })?.signature;
          writeSignatureCache(staff.staff_id, persisted ?? (sig.trim() ? sig : ""));
        }
        if (nameChanged) await loadMe(); // 重新載入 /me,讓頂欄等處反映新顯示名稱
      }
      setSound(soundOn); // 音效偏好持久化(notify store persist)
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("config.common.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  // 各子頁自帶 PageShell,直接分派
  if (tab === "brand") return <BrandSettings />;
  if (tab === "staff") return <StaffSettingsPage />;
  if (tab === "skills") return <SkillsSettingsPage />;
  if (tab === "rbac") return <RbacSettingsPage />;
  if (tab === "llm") return <LlmSettingsPage />;
  if (tab === "canned") return <CannedPage />;
  if (tab === "macros") return <MacrosSettingsPage />;
  if (tab === "widget") return <WidgetSettingsPage />;
  if (tab === "translate") return <TranslationSettingsPage />;
  if (tab === "tags") return <TagsSettingsPage />;
  if (tab === "automation") return <AutomationSettingsPage />;
  if (tab === "proactive") return <ProactiveSettingsPage />;
  if (tab === "sla") return <SlaSettingsPage />;
  if (tab === "email") return <EmailChannelSettingsPage />;
  if (tab === "meta") return <MetaChannelSettingsPage />;
  if (tab === "webhooks") return <WebhookSettingsPage />;
  if (tab === "apikeys") return <ApiKeySettingsPage />;
  if (tab === "helpcenter") return <HelpCenterSettingsPage />;
  if (tab === "domains") return <DomainsSettingsPage />;
  if (tab === "schedule") return <ScheduleSettings />;
  if (tab === "goals") return <GoalsSettings />;
  if (tab === "integrations") return <IntegrationsSettings />;
  if (tab === "security") return <SecuritySettings />;
  if (tab === "sso") return <SsoSettings />;
  if (tab === "2fa") return <TwoFactorSettings />;
  if (tab === "audit") return <AuditPage />;

  // 預設:個人資料(品牌 / 外觀 tab 見上方 BrandSettings 分支)
  return (
    <PageShell title={t("nav.settings")} description={t("core.settingsDescription")}>
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-sm">{t("core.settingsProfile")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("core.settingsDisplayName")}</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={staff?.email ?? ""} disabled />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="staff-signature">
              {t("settings.signature.label", { defaultValue: "簽名檔" })}
            </Label>
            <Textarea
              id="staff-signature"
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              rows={4}
              placeholder={t("settings.signature.placeholder", {
                defaultValue: "例如:\n—\n王小明 | 客服專員 | ACME 支援中心",
              })}
              className="min-h-[88px] font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              {t("settings.signature.hint", {
                defaultValue:
                  "回覆客戶時可自動附加於訊息末端;是否附加由輸入框的「附加簽名」開關控制。",
              })}
            </p>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <p className="text-sm">{t("core.settingsNewMessageSound")}</p>
              <p className="text-xs text-muted-foreground">{t("core.settingsNewMessageSoundHint")}</p>
            </div>
            <Switch checked={soundOn} onCheckedChange={setSoundOn} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <p className="text-sm">{t("account.changePassword")}</p>
              <p className="text-xs text-muted-foreground">{t("account.changePasswordHint")}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setPwOpen(true)}>
              {t("account.changePassword")}
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button onClick={saveProfile} disabled={saving || !displayName.trim()}>
              {saving ? t("config.common.saving") : t("common.save")}
            </Button>
            {saved && (
              <span className="flex items-center gap-1 text-xs text-success">
                <Check className="h-3.5 w-3.5" /> {t("config.common.saved")}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </PageShell>
  );
}
