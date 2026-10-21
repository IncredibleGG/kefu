import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck,
  KeyRound,
  Users,
  Copy,
  Check,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/api/client";
import { ssoApi } from "@/api/sso";

/** 唯讀欄位 + 複製按鈕(供貼入 IdP / SCIM 用戶端)。 */
function ReadonlyField({
  label,
  value,
  copiedKey,
  onCopy,
  fieldKey,
}: {
  label: string;
  value: string;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
  fieldKey: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input value={value} readOnly spellCheck={false} className="font-mono text-xs" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onCopy(value, fieldKey)}
          disabled={!value}
        >
          {copiedKey === fieldKey ? (
            <Check className="h-4 w-4 text-success" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * 企業 SSO 設定頁(對標 LiveChat / Zendesk 企業版):
 *   1. SAML 2.0 — IdP 設定(entityID / SSO URL / 簽章憑證)+ SP metadata/ACS/entityID 顯示
 *   2. SCIM 2.0 — 自動佈建開關、預設角色、產生 bearer 權杖(明文僅一次)
 * 本頁自帶 PageShell,由 SettingsPage 以 ?tab=sso 分派掛載。端點需 settings.manage。
 * 零回歸:未啟用時後端所有 SSO 端點回 disabled,不影響既有 Google OAuth / 密碼登入。
 */
export function SsoSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const configQuery = useQuery({
    queryKey: ["sso", "config"],
    queryFn: () => ssoApi.getConfig(),
  });
  const config = configQuery.data;

  // SAML 編輯狀態
  const [samlEnabled, setSamlEnabled] = useState(false);
  const [idpEntityId, setIdpEntityId] = useState("");
  const [idpSsoUrl, setIdpSsoUrl] = useState("");
  const [x509Cert, setX509Cert] = useState("");
  // SCIM 編輯狀態
  const [scimEnabled, setScimEnabled] = useState(false);
  const [defaultRole, setDefaultRole] = useState("");

  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (config) {
      setSamlEnabled(config.saml_enabled);
      setIdpEntityId(config.saml_idp_entity_id ?? "");
      setIdpSsoUrl(config.saml_idp_sso_url ?? "");
      setX509Cert(config.saml_idp_x509_cert ?? "");
      setScimEnabled(config.scim_enabled);
      setDefaultRole(config.default_role ?? "");
    }
  }, [config]);

  function showFlash(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2200);
  }

  function errMsg(e: unknown): string {
    if (e instanceof ApiError && e.code === "UNAUTHORIZED") {
      return t("sso.noPermission", { defaultValue: "您沒有管理企業 SSO 設定的權限" });
    }
    return e instanceof Error ? e.message : t("sso.saveError", { defaultValue: "儲存失敗" });
  }

  async function copy(text: string, key: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      /* 剪貼簿不可用時忽略;使用者仍可手動選取 */
    }
  }

  const saveSamlMut = useMutation({
    mutationFn: () =>
      ssoApi.updateConfig({
        saml_enabled: samlEnabled,
        saml_idp_entity_id: idpEntityId.trim() || null,
        saml_idp_sso_url: idpSsoUrl.trim() || null,
        saml_idp_x509_cert: x509Cert.trim() || null,
      }),
    onSuccess: (data) => {
      setError(null);
      qc.setQueryData(["sso", "config"], data);
      showFlash(t("sso.saved", { defaultValue: "已儲存" }));
    },
    onError: (e) => setError(errMsg(e)),
  });

  const saveScimMut = useMutation({
    mutationFn: () =>
      ssoApi.updateConfig({
        scim_enabled: scimEnabled,
        default_role: defaultRole.trim() || null,
      }),
    onSuccess: (data) => {
      setError(null);
      qc.setQueryData(["sso", "config"], data);
      showFlash(t("sso.saved", { defaultValue: "已儲存" }));
    },
    onError: (e) => setError(errMsg(e)),
  });

  const genTokenMut = useMutation({
    mutationFn: () => ssoApi.generateScimToken(),
    onSuccess: (data) => {
      setError(null);
      setFreshToken(data.token);
      qc.invalidateQueries({ queryKey: ["sso", "config"] });
    },
    onError: (e) => setError(errMsg(e)),
  });

  const loginUrl = config ? config.sp_metadata_url.replace("/metadata/", "/login/") : "";
  const isStructural = config?.signature_verification === "structural";

  return (
    <PageShell
      title={t("sso.title", { defaultValue: "企業 SSO" })}
      description={t("sso.description", {
        defaultValue:
          "SAML 2.0 單一登入與 SCIM 2.0 自動佈建。接上企業 IdP 設定即用;未設定則不啟用,不影響既有登入。",
      })}
    >
      {configQuery.isLoading ? (
        <Skeleton className="h-64 max-w-2xl" />
      ) : configQuery.isError ? (
        <Card className="max-w-2xl">
          <CardContent className="py-8">
            <p className="text-sm text-destructive">{errMsg(configQuery.error)}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="max-w-2xl space-y-6">
          {flash && (
            <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
              <Check className="h-4 w-4" />
              {flash}
            </div>
          )}

          {/* 1. SAML IdP 設定 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-brand" />
                {t("sso.samlTitle", { defaultValue: "SAML 2.0 單一登入" })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="saml-enabled">
                    {t("sso.samlEnable", { defaultValue: "啟用 SAML 登入" })}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t("sso.samlEnableHint", {
                      defaultValue:
                        "啟用後,已存在的坐席可透過企業 IdP(Okta / Azure AD / OneLogin 等)登入。僅比對既有 email,不自動開帳號(除非 SCIM 已佈建)。",
                    })}
                  </p>
                </div>
                <Switch id="saml-enabled" checked={samlEnabled} onCheckedChange={setSamlEnabled} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="idp-entity-id">
                  {t("sso.idpEntityId", { defaultValue: "IdP EntityID" })}
                </Label>
                <Input
                  id="idp-entity-id"
                  value={idpEntityId}
                  onChange={(e) => setIdpEntityId(e.target.value)}
                  spellCheck={false}
                  placeholder="https://idp.example.com/saml/metadata"
                  className="font-mono text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="idp-sso-url">
                  {t("sso.idpSsoUrl", { defaultValue: "IdP SSO URL(登入端點)" })}
                </Label>
                <Input
                  id="idp-sso-url"
                  value={idpSsoUrl}
                  onChange={(e) => setIdpSsoUrl(e.target.value)}
                  spellCheck={false}
                  placeholder="https://idp.example.com/sso/saml"
                  className="font-mono text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="idp-cert">
                  {t("sso.idpCert", { defaultValue: "IdP 簽章憑證(X.509,PEM 或 base64)" })}
                </Label>
                <Textarea
                  id="idp-cert"
                  value={x509Cert}
                  onChange={(e) => setX509Cert(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  placeholder={"-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----"}
                  className="min-h-[110px] font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  {t("sso.idpCertHint", {
                    defaultValue: "用於驗證 IdP 回傳的 SAML 斷言簽章。此為公開憑證(非私鑰)。",
                  })}
                </p>
              </div>

              {isStructural && (
                <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {t("sso.structuralWarn", {
                      defaultValue:
                        "目前為「結構驗證」模式(解析 + 憑證釘選 + 時效檢查),尚未做完整 XML-DSig 密碼學驗簽。正式上線前請於後端加裝 python3-saml / signxml 依賴以啟用完整驗簽。",
                    })}
                  </span>
                </div>
              )}

              <Button onClick={() => saveSamlMut.mutate()} disabled={saveSamlMut.isPending}>
                {saveSamlMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("sso.save", { defaultValue: "儲存" })}
              </Button>
            </CardContent>
          </Card>

          {/* 2. SP 資訊(貼入 IdP) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <KeyRound className="h-4 w-4 text-brand" />
                {t("sso.spTitle", { defaultValue: "服務供應商(SP)資訊" })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t("sso.spDesc", { defaultValue: "把以下資訊填入您的 IdP 應用程式設定。" })}
              </p>
              {config && (
                <>
                  <ReadonlyField
                    label={t("sso.spEntityId", { defaultValue: "SP EntityID" })}
                    value={config.sp_entity_id}
                    copiedKey={copiedKey}
                    onCopy={copy}
                    fieldKey="sp_entity_id"
                  />
                  <ReadonlyField
                    label={t("sso.spAcsUrl", { defaultValue: "ACS URL(Assertion Consumer Service)" })}
                    value={config.sp_acs_url}
                    copiedKey={copiedKey}
                    onCopy={copy}
                    fieldKey="sp_acs_url"
                  />
                  <ReadonlyField
                    label={t("sso.spMetadataUrl", { defaultValue: "SP Metadata URL" })}
                    value={config.sp_metadata_url}
                    copiedKey={copiedKey}
                    onCopy={copy}
                    fieldKey="sp_metadata_url"
                  />
                  <ReadonlyField
                    label={t("sso.loginUrl", { defaultValue: "登入啟動 URL(SP-initiated)" })}
                    value={loginUrl}
                    copiedKey={copiedKey}
                    onCopy={copy}
                    fieldKey="login_url"
                  />
                </>
              )}
            </CardContent>
          </Card>

          {/* 3. SCIM 自動佈建 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Users className="h-4 w-4 text-brand" />
                {t("sso.scimTitle", { defaultValue: "SCIM 2.0 自動佈建" })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="scim-enabled">
                    {t("sso.scimEnable", { defaultValue: "啟用 SCIM 佈建" })}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t("sso.scimEnableHint", {
                      defaultValue:
                        "啟用後,IdP 可透過 SCIM 自動建立 / 停用 / 移除坐席帳號,免手動邀請。",
                    })}
                  </p>
                </div>
                <Switch id="scim-enabled" checked={scimEnabled} onCheckedChange={setScimEnabled} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="default-role">
                  {t("sso.defaultRole", { defaultValue: "佈建坐席的預設角色" })}
                </Label>
                <Input
                  id="default-role"
                  value={defaultRole}
                  onChange={(e) => setDefaultRole(e.target.value)}
                  spellCheck={false}
                  placeholder="agent"
                />
                <p className="text-xs text-muted-foreground">
                  {t("sso.defaultRoleHint", {
                    defaultValue: "SCIM 建立與 SAML 首次登入的坐席將指派此角色(須為租戶內既有角色;預設 agent)。",
                  })}
                </p>
              </div>

              <Button onClick={() => saveScimMut.mutate()} disabled={saveScimMut.isPending}>
                {saveScimMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("sso.save", { defaultValue: "儲存" })}
              </Button>

              {config && (
                <ReadonlyField
                  label={t("sso.scimBaseUrl", { defaultValue: "SCIM Base URL" })}
                  value={config.scim_base_url}
                  copiedKey={copiedKey}
                  onCopy={copy}
                  fieldKey="scim_base_url"
                />
              )}

              <div className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="text-sm">
                      {t("sso.scimToken", { defaultValue: "SCIM Bearer 權杖" })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {config?.scim_token_set
                        ? t("sso.scimTokenSet", { defaultValue: "已設定權杖;重新產生會使舊權杖立即失效。" })
                        : t("sso.scimTokenNone", { defaultValue: "尚未產生權杖。" })}
                    </p>
                  </div>
                  {config?.scim_token_set && (
                    <Badge variant="secondary">{t("sso.scimTokenBadge", { defaultValue: "已設定" })}</Badge>
                  )}
                </div>

                {freshToken && (
                  <div className="space-y-2 rounded-md border border-warning/30 bg-warning/10 p-3">
                    <div className="flex items-start gap-2 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        {t("sso.scimTokenWarn", {
                          defaultValue: "請立即保存此權杖並貼入 IdP;離開此頁後將無法再次顯示。",
                        })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input value={freshToken} readOnly spellCheck={false} className="font-mono text-xs" />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => copy(freshToken, "scim_token")}
                      >
                        {copiedKey === "scim_token" ? (
                          <Check className="h-4 w-4 text-success" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                <Button
                  variant={config?.scim_token_set ? "outline" : "default"}
                  onClick={() => genTokenMut.mutate()}
                  disabled={genTokenMut.isPending}
                >
                  {genTokenMut.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {config?.scim_token_set
                    ? t("sso.scimTokenRegenerate", { defaultValue: "重新產生權杖" })
                    : t("sso.scimTokenGenerate", { defaultValue: "產生權杖" })}
                </Button>
              </div>
            </CardContent>
          </Card>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      )}
    </PageShell>
  );
}
