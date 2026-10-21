import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  X,
  Sparkles,
  Crown,
  Gift,
  Loader2,
  CreditCard,
  Gauge,
  Receipt,
  FileText,
  Percent,
  Plus,
  Download,
  Save,
} from "lucide-react";
import i18n from "@/lib/i18n";
import { PageShell } from "@/components/layout/PageShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePlans, useSubscription, useFeatures } from "@/api/hooks";
import { billingApi } from "@/api/endpoints";
import { checkoutApi } from "@/api/checkout";
import { ApiError, call } from "@/api/client";
import { cn } from "@/lib/utils";
import { publicUrl } from "@/lib/server";
import { isNative, openExternal } from "@/lib/platform";
import type { FeatureMap, Plan } from "@/types";

const PLAN_ICON: Record<string, typeof Gift> = { free: Gift, pro: Sparkles, enterprise: Crown };

/* ---- 本租戶用量 / 帳單試算(GET /billing/usage、/billing/invoice/summary 回應形狀)---- */
interface UsageResponse {
  tenant_id: string;
  usage: Record<string, number>;
}
interface InvoiceLineItem {
  kind: string;
  quantity: number;
  included: number;
  billable_quantity: number;
  unit_price: number;
  amount: number;
  self_funded: boolean;
}
interface InvoiceCharges {
  currency: string;
  base_fee: number;
  line_items: InvoiceLineItem[];
  metered_total: number;
  total: number;
  byo_key: boolean;
}
interface InvoiceSummaryResponse {
  tenant_id: string;
  plan: Plan | null;
  usage: Record<string, number>;
  charges: InvoiceCharges | null;
}

/* ---- 發票 / 稅務 / 優惠券(對接 /billing/invoices、/billing/settings、/billing/coupons)---- */
interface BillingSettings {
  tax_rate: number;
  tax_label: string | null;
  vat_number: string | null;
  billing_address: Record<string, string> | null;
}
interface BillingSettingsResponse {
  tenant_id: string;
  settings: BillingSettings;
}
interface InvoiceLineRow {
  type: string;
  kind?: string;
  description?: string;
  quantity?: number;
  billable_quantity?: number;
  unit_price?: number;
  amount_cents: number;
  self_funded?: boolean;
}
interface Invoice {
  id: string;
  number: string;
  tenant_id: string;
  period_start: string | null;
  period_end: string | null;
  line_items: InvoiceLineRow[];
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  status: "draft" | "open" | "paid" | "void";
  issued_at: string | null;
  paid_at: string | null;
  stripe_invoice_id: string | null;
  meta: Record<string, unknown>;
}
interface Coupon {
  id: string;
  code: string;
  percent_off: number | null;
  amount_off_cents: number | null;
  currency: string;
  valid_until: string | null;
  max_redemptions: number | null;
  redeemed_count: number;
  is_active: boolean;
  stripe_coupon_id: string | null;
}

const INVOICE_STATUS_LABELS: Record<Invoice["status"], string> = {
  draft: "草稿",
  open: "待付款",
  paid: "已付款",
  void: "已作廢",
};
const INVOICE_STATUS_VARIANT: Record<Invoice["status"], "secondary" | "success" | "brand"> = {
  draft: "secondary",
  open: "brand",
  paid: "success",
  void: "secondary",
};

// 計量 kind → 顯示名(對齊後端 services/usage.py 的約定值;未知 kind 原樣顯示)
const KIND_LABELS: Record<string, string> = {
  llm_tokens: "LLM Token",
  ai_reply: "AI 自動回覆",
  session: "會話數",
  message: "訊息數",
  agent_seat: "坐席席位",
};

function price(cents: number) {
  if (!cents) return i18n.t("modules.billing.free");
  return `$${Math.round(cents / 100)}`;
}

function formatQty(n: number): string {
  const v = Number(n) || 0;
  return Number.isInteger(v)
    ? v.toLocaleString()
    : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** 金額格式化:後端已回貨幣主單位(見 usage.estimate_charges)。USD 用 $,其餘以幣別碼前綴。 */
function money(v: number, currency: string): string {
  const amount = (Number(v) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "USD" ? `$${amount}` : `${currency} ${amount}`;
}

/** 分 → 顯示金額(發票金額一律以分存放,顯示時除以 100)。 */
function moneyCents(cents: number, currency: string): string {
  return money((Number(cents) || 0) / 100, currency);
}

/** ISO 時間 → 本地日期(僅日期,發票 / 期間顯示用)。 */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function featureLabel(value: boolean | number | null): { on: boolean; text: string } {
  if (typeof value === "boolean") return { on: value, text: value ? i18n.t("modules.billing.included") : "—" };
  if (value === null) return { on: true, text: i18n.t("modules.billing.unlimited") };
  return { on: value > 0, text: String(value) };
}

/** 取功能生效值:鍵存在(即使值為 null=無限)就用該值,只有「鍵缺失」才回退目錄預設。
 *  切勿用 `feats[key] ?? default`:?? 會把合法的 null(無限,如 Enterprise 座席)當成缺值
 *  而回退成目錄預設數(3),造成 Enterprise 座席顯示 3、比 Pro 的 25 還少的錯誤。 */
function resolveFeatureValue(
  feats: FeatureMap | null | undefined,
  key: string,
  fallback: boolean | number | null,
): boolean | number | null {
  return feats && key in feats ? feats[key] : fallback;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

export function BillingPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const plans = usePlans();
  const sub = useSubscription();
  const features = useFeatures();
  // 本租戶用量與帳單試算(billingApi 已有方法,型別在此就地標註)
  const usageQuery = useQuery({
    queryKey: ["billing", "usage"],
    queryFn: () => billingApi.usage() as Promise<UsageResponse>,
  });
  const invoiceQuery = useQuery({
    queryKey: ["billing", "invoice"],
    queryFn: () => billingApi.invoice() as Promise<InvoiceSummaryResponse>,
  });
  const usageEntries = Object.entries(usageQuery.data?.usage ?? {});
  const charges = invoiceQuery.data?.charges ?? null;
  const [switching, setSwitching] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [stripeNotice, setStripeNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- 帳單設定 / 發票 / 優惠券(對接 /billing/settings、/billing/invoices、/billing/coupons)----
  const settingsQuery = useQuery({
    queryKey: ["billing", "settings"],
    queryFn: () => call<BillingSettingsResponse>({ path: "/api/v1/billing/settings", real: true }),
  });
  const invoicesQuery = useQuery({
    queryKey: ["billing", "invoices"],
    queryFn: () => call<{ invoices: Invoice[] }>({ path: "/api/v1/billing/invoices", real: true }),
  });
  const couponsQuery = useQuery({
    queryKey: ["billing", "coupons"],
    queryFn: () => call<{ coupons: Coupon[] }>({ path: "/api/v1/billing/coupons", real: true }),
  });

  // 稅務 / 帳單設定表單(載入後由 settingsQuery 回填)
  const [taxRate, setTaxRate] = useState("0");
  const [taxLabel, setTaxLabel] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [billTo, setBillTo] = useState("");
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  useEffect(() => {
    const s = settingsQuery.data?.settings;
    if (!s) return;
    setTaxRate(String(s.tax_rate ?? 0));
    setTaxLabel(s.tax_label ?? "");
    setVatNumber(s.vat_number ?? "");
    setBillTo((s.billing_address && (s.billing_address.line1 as string)) || "");
  }, [settingsQuery.data]);

  const saveSettings = useMutation({
    mutationFn: () =>
      call<BillingSettingsResponse>({
        path: "/api/v1/billing/settings",
        method: "PUT",
        real: true,
        body: {
          tax_rate: Number(taxRate) || 0,
          tax_label: taxLabel || null,
          vat_number: vatNumber || null,
          billing_address: billTo ? { line1: billTo } : null,
        },
      }),
    onSuccess: () => {
      setSettingsMsg(t("billing2.settingsSaved", { defaultValue: "帳單設定已儲存" }));
      qc.invalidateQueries({ queryKey: ["billing", "settings"] });
    },
    onError: (e) =>
      setSettingsMsg(e instanceof Error ? e.message : t("billing2.saveFailed", { defaultValue: "儲存失敗" })),
  });

  // 優惠券建立
  const [couponCode, setCouponCode] = useState("");
  const [couponType, setCouponType] = useState<"percent" | "amount">("percent");
  const [couponValue, setCouponValue] = useState("");
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const createCoupon = useMutation({
    mutationFn: () => {
      const val = Number(couponValue) || 0;
      return call<Coupon>({
        path: "/api/v1/billing/coupons",
        method: "POST",
        real: true,
        body: {
          code: couponCode.trim(),
          percent_off: couponType === "percent" ? val : null,
          amount_off_cents: couponType === "amount" ? Math.round(val * 100) : null,
        },
      });
    },
    onSuccess: () => {
      setCouponMsg(t("billing2.couponCreated", { defaultValue: "優惠券已建立" }));
      setCouponCode("");
      setCouponValue("");
      qc.invalidateQueries({ queryKey: ["billing", "coupons"] });
    },
    onError: (e) =>
      setCouponMsg(e instanceof Error ? e.message : t("billing2.createFailed", { defaultValue: "建立失敗" })),
  });

  // 發票產出 / 標記
  const [genCoupon, setGenCoupon] = useState("");
  const [invoiceMsg, setInvoiceMsg] = useState<string | null>(null);
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  const generateInvoice = useMutation({
    mutationFn: () =>
      call<Invoice>({
        path: "/api/v1/billing/invoices/generate",
        method: "POST",
        real: true,
        body: { coupon_code: genCoupon.trim() || null, status: "open" },
      }),
    onSuccess: (inv) => {
      setInvoiceMsg(t("billing2.invoiceGenerated", { defaultValue: "已產出發票 {{number}}", number: inv.number }));
      setGenCoupon("");
      qc.invalidateQueries({ queryKey: ["billing", "invoices"] });
      qc.invalidateQueries({ queryKey: ["billing", "coupons"] });
    },
    onError: (e) =>
      setInvoiceMsg(e instanceof Error ? e.message : t("billing2.generateFailed", { defaultValue: "產出失敗" })),
  });
  const markInvoice = useMutation({
    mutationFn: (args: { id: string; status: Invoice["status"] }) =>
      call<Invoice>({
        path: `/api/v1/billing/invoices/${args.id}/status`,
        method: "POST",
        real: true,
        body: { status: args.status },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["billing", "invoices"] }),
  });

  const invoices = invoicesQuery.data?.invoices ?? [];
  const coupons = couponsQuery.data?.coupons ?? [];

  const currentPlanId = sub.data?.plan?.id;
  // 目前生效方案的價格(分):用於判斷某方案是否為「需付款的升級」。無方案(Free)視為 0。
  const currentPrice = sub.data?.plan
    ? sub.data.plan.price_monthly || sub.data.plan.price_cents || 0
    : 0;
  const currentFeatures: FeatureMap = features.data?.features ?? sub.data?.features ?? {};
  const catalog = features.data?.catalog ?? {};
  const catalogKeys = Object.keys(catalog);

  async function switchPlan(plan: Plan) {
    if (plan.id === currentPlanId) return;
    setSwitching(plan.id);
    setError(null);
    setStripeNotice(null);
    try {
      await billingApi.changePlan(plan.id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["billing", "subscription"] }),
        qc.invalidateQueries({ queryKey: ["billing", "features"] }),
      ]);
    } catch (e) {
      // 付費方案自助升級被後端門檻擋下(PAYMENT_REQUIRED):不是失敗,而是需先付款。
      // 以顯眼提示引導改走「訂閱 / 升級」結帳,而非顯示成一般錯誤或假裝切換成功。
      if (e instanceof ApiError && e.code === "PAYMENT_REQUIRED") {
        setStripeNotice(
          t("billing.paymentRequired", {
            defaultValue:
              "切換至付費方案需先完成付款,請點「訂閱 / 升級」前往結帳(若線上金流尚未啟用,請聯繫平台開通)。",
          }),
        );
      } else {
        setError(e instanceof Error ? e.message : t("modules.billing.switchPlanFailed"));
      }
    } finally {
      setSwitching(null);
    }
  }

  /** 訂閱 / 升級:呼叫後端建立 Stripe Checkout,導向託管結帳頁(卡號輸入全在 Stripe)。
   *  後端未設定金鑰時回 BILLING_STRIPE_DISABLED,顯示測試模式提示,不崩。 */
  async function startCheckout(plan: Plan) {
    setCheckingOut(plan.id);
    setError(null);
    setStripeNotice(null);
    try {
      // Stripe 導回網址必須是 http(s):原生殼用伺服器的公開網址(App origin 為 tauri:// / capacitor://)
      const origin = isNative ? publicUrl("/billing") : window.location.origin + window.location.pathname;
      const res = await checkoutApi.create(
        plan.id,
        `${origin}?checkout=success`,
        `${origin}?checkout=cancel`,
      );
      if (res.url) {
        // 原生殼:於系統瀏覽器開啟結帳頁,不把 App webview 導離
        if (isNative) void openExternal(res.url);
        else window.location.assign(res.url);
      } else {
        setError(t("billing.checkoutFailed", { defaultValue: "建立結帳工作階段失敗" }));
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "BILLING_STRIPE_DISABLED") {
        setStripeNotice(
          t("billing.stripeDisabled", {
            defaultValue: "測試模式:請管理員設定 Stripe 金鑰",
          }),
        );
      } else {
        setError(
          e instanceof Error ? e.message : t("billing.checkoutFailed", { defaultValue: "建立結帳工作階段失敗" }),
        );
      }
    } finally {
      setCheckingOut(null);
    }
  }

  const loading = plans.isLoading || sub.isLoading || features.isLoading;
  const sortedPlans = [...(plans.data ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

  return (
    <PageShell title={t("modules.billing.pageTitle")} description={t("modules.billing.pageDescription")}>
      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {stripeNotice && (
        <div className="mb-3 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {stripeNotice}
        </div>
      )}

      {/* 當前方案 */}
      <Card className="mb-4 border-brand/40 bg-brand/5">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-xs text-muted-foreground">{t("modules.billing.currentPlan")}</p>
            {sub.isLoading ? (
              <Skeleton className="mt-1 h-6 w-24" />
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold">{sub.data?.plan?.name ?? "Free"}</span>
                <Badge variant={sub.data?.subscription?.status === "active" ? "success" : "secondary"}>
                  {sub.data?.subscription?.status ?? "free"}
                </Badge>
              </div>
            )}
          </div>
          {sub.data?.plan && (
            <div className="text-right">
              <p className="text-2xl font-bold">{price(sub.data.plan.price_monthly)}</p>
              <p className="text-xs text-muted-foreground">{t("modules.billing.perMonth")}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 本租戶目前用量 + 帳單試算(接 /billing/usage、/billing/invoice/summary) */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 本期用量(依 kind 聚合) */}
        <Card>
          <CardHeader className="flex-row items-center gap-2">
            <Gauge className="h-4 w-4 text-brand" />
            <CardTitle className="text-sm">本期用量</CardTitle>
          </CardHeader>
          <CardContent>
            {usageQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : usageQuery.isError ? (
              <p className="text-xs text-muted-foreground">無法載入用量資料</p>
            ) : usageEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">本期尚無用量記錄</p>
            ) : (
              <div className="space-y-2">
                {usageEntries.map(([kind, qty]) => (
                  <div
                    key={kind}
                    className="flex items-center justify-between border-b border-border/60 pb-1.5 text-sm last:border-0 last:pb-0"
                  >
                    <span className="text-muted-foreground">{KIND_LABELS[kind] ?? kind}</span>
                    <span className="font-medium tabular-nums">{formatQty(qty)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 帳單試算摘要(基礎費 + 用量計費) */}
        <Card>
          <CardHeader className="flex-row items-center gap-2">
            <Receipt className="h-4 w-4 text-brand" />
            <CardTitle className="text-sm">帳單試算</CardTitle>
          </CardHeader>
          <CardContent>
            {invoiceQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : invoiceQuery.isError || !charges ? (
              <p className="text-xs text-muted-foreground">無法載入帳單試算</p>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">方案基礎費</span>
                  <span className="font-medium tabular-nums">
                    {money(charges.base_fee, charges.currency)}
                  </span>
                </div>
                {charges.line_items
                  .filter((li) => li.billable_quantity > 0 || li.amount > 0)
                  .map((li) => (
                    <div
                      key={li.kind}
                      className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                    >
                      <span className="min-w-0 truncate">
                        {KIND_LABELS[li.kind] ?? li.kind}(
                        {formatQty(li.billable_quantity)} × {money(li.unit_price, charges.currency)}
                        {li.self_funded ? "・自負" : ""})
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {money(li.amount, charges.currency)}
                      </span>
                    </div>
                  ))}
                <div className="flex items-center justify-between border-t border-border pt-2">
                  <span className="text-muted-foreground">用量計費小計</span>
                  <span className="font-medium tabular-nums">
                    {money(charges.metered_total, charges.currency)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-semibold">預估總額</span>
                  <span className="text-lg font-bold tabular-nums">
                    {money(charges.total, charges.currency)}
                  </span>
                </div>
                {charges.byo_key && (
                  <p className="text-[11px] text-muted-foreground">
                    已啟用 BYO-Key,LLM 用量由你自付,平台不計費。
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 稅務 / 帳單設定 + 優惠券管理 */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 稅務 / 帳單設定 */}
        <Card>
          <CardHeader className="flex-row items-center gap-2">
            <Percent className="h-4 w-4 text-brand" />
            <CardTitle className="text-sm">{t("billing2.taxSettings", { defaultValue: "稅務 / 帳單設定" })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {settingsMsg && <p className="text-xs text-muted-foreground">{settingsMsg}</p>}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="tax-rate">{t("billing2.taxRate", { defaultValue: "稅率(%)" })}</Label>
                <Input
                  id="tax-rate"
                  type="number"
                  min={0}
                  max={100}
                  value={taxRate}
                  onChange={(e) => setTaxRate(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tax-label">{t("billing2.taxLabel", { defaultValue: "稅名" })}</Label>
                <Input id="tax-label" value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} placeholder="VAT" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="vat">{t("billing2.vatNumber", { defaultValue: "VAT / 統一編號" })}</Label>
              <Input id="vat" value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="billto">{t("billing2.billingAddress", { defaultValue: "帳單地址" })}</Label>
              <Input id="billto" value={billTo} onChange={(e) => setBillTo(e.target.value)} />
            </div>
            <Button
              variant="default"
              disabled={saveSettings.isPending}
              onClick={() => {
                setSettingsMsg(null);
                saveSettings.mutate();
              }}
            >
              {saveSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t("billing2.saveSettings", { defaultValue: "儲存設定" })}
            </Button>
          </CardContent>
        </Card>

        {/* 優惠券 */}
        <Card>
          <CardHeader className="flex-row items-center gap-2">
            <Gift className="h-4 w-4 text-brand" />
            <CardTitle className="text-sm">{t("billing2.coupons", { defaultValue: "優惠券" })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {couponMsg && <p className="text-xs text-muted-foreground">{couponMsg}</p>}
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="coupon-code">{t("billing2.couponCode", { defaultValue: "折扣碼" })}</Label>
                <Input id="coupon-code" value={couponCode} onChange={(e) => setCouponCode(e.target.value)} className="w-32" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="coupon-type">{t("billing2.discountType", { defaultValue: "類型" })}</Label>
                <select
                  id="coupon-type"
                  value={couponType}
                  onChange={(e) => setCouponType(e.target.value as "percent" | "amount")}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="percent">{t("billing2.percentOff", { defaultValue: "百分比 %" })}</option>
                  <option value="amount">{t("billing2.amountOff", { defaultValue: "固定金額" })}</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="coupon-value">
                  {couponType === "percent" ? "%" : t("billing2.amountUnit", { defaultValue: "金額" })}
                </Label>
                <Input
                  id="coupon-value"
                  type="number"
                  min={0}
                  value={couponValue}
                  onChange={(e) => setCouponValue(e.target.value)}
                  className="w-24"
                />
              </div>
              <Button
                variant="default"
                disabled={createCoupon.isPending || !couponCode.trim() || !couponValue}
                onClick={() => {
                  setCouponMsg(null);
                  createCoupon.mutate();
                }}
              >
                {createCoupon.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {t("billing2.createCoupon", { defaultValue: "建立" })}
              </Button>
            </div>
            {couponsQuery.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : coupons.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("billing2.noCoupons", { defaultValue: "尚無優惠券" })}</p>
            ) : (
              <div className="space-y-1.5">
                {coupons.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between gap-2 border-b border-border/60 pb-1.5 text-sm last:border-0 last:pb-0"
                  >
                    <span className="font-mono">{c.code}</span>
                    <span className="text-muted-foreground">
                      {c.percent_off != null
                        ? `${c.percent_off}%`
                        : c.amount_off_cents != null
                          ? moneyCents(c.amount_off_cents, c.currency)
                          : "—"}
                      {c.max_redemptions != null ? ` · ${c.redeemed_count}/${c.max_redemptions}` : ""}
                    </span>
                    <Badge variant={c.is_active ? "success" : "secondary"}>
                      {c.is_active
                        ? t("billing2.active", { defaultValue: "啟用" })
                        : t("billing2.inactive", { defaultValue: "停用" })}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 發票 / 帳單歷史 */}
      <Card className="mb-4">
        <CardHeader className="flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-brand" />
            <CardTitle className="text-sm">{t("billing2.invoices", { defaultValue: "發票 / 帳單歷史" })}</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={genCoupon}
              onChange={(e) => setGenCoupon(e.target.value)}
              placeholder={t("billing2.couponOptional", { defaultValue: "優惠券碼(選填)" })}
              className="h-8 w-40"
            />
            <Button
              size="sm"
              disabled={generateInvoice.isPending}
              onClick={() => {
                setInvoiceMsg(null);
                generateInvoice.mutate();
              }}
            >
              {generateInvoice.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />}
              {t("billing2.generateInvoice", { defaultValue: "產出本期發票" })}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {invoiceMsg && <p className="mb-2 text-xs text-muted-foreground">{invoiceMsg}</p>}
          {invoicesQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : invoices.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("billing2.noInvoices", { defaultValue: "尚無發票,點「產出本期發票」建立第一張。" })}
            </p>
          ) : (
            <div className="space-y-2">
              {invoices.map((inv) => (
                <div key={inv.id} className="rounded-md border border-border">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 p-3 text-left"
                    onClick={() => setOpenInvoiceId(openInvoiceId === inv.id ? null : inv.id)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{inv.number}</span>
                      <Badge variant={INVOICE_STATUS_VARIANT[inv.status]}>{INVOICE_STATUS_LABELS[inv.status]}</Badge>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">{formatDate(inv.issued_at)}</span>
                      <span className="font-semibold tabular-nums">{moneyCents(inv.total_cents, inv.currency)}</span>
                    </div>
                  </button>
                  {openInvoiceId === inv.id && (
                    <div className="border-t border-border p-3 text-sm">
                      <div className="space-y-1">
                        {inv.line_items.map((li, idx) => (
                          <div
                            key={idx}
                            className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                          >
                            <span className="min-w-0 truncate">
                              {li.type === "base"
                                ? t("billing2.baseFee", { defaultValue: "方案基礎費" })
                                : (KIND_LABELS[li.kind ?? ""] ?? li.kind)}
                              {li.type === "metered" && li.billable_quantity != null
                                ? `(${formatQty(li.billable_quantity)}${li.self_funded ? "・自負" : ""})`
                                : ""}
                            </span>
                            <span className="shrink-0 tabular-nums">{moneyCents(li.amount_cents, inv.currency)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 space-y-1 border-t border-border pt-2">
                        <SummaryRow label={t("billing2.subtotal", { defaultValue: "小計" })} value={moneyCents(inv.subtotal_cents, inv.currency)} />
                        {inv.discount_cents > 0 && (
                          <SummaryRow
                            label={t("billing2.discount", { defaultValue: "折扣" })}
                            value={`− ${moneyCents(inv.discount_cents, inv.currency)}`}
                          />
                        )}
                        {inv.tax_cents > 0 && (
                          <SummaryRow label={t("billing2.tax", { defaultValue: "稅額" })} value={moneyCents(inv.tax_cents, inv.currency)} />
                        )}
                        <div className="flex items-center justify-between font-semibold">
                          <span>{t("billing2.total", { defaultValue: "總計" })}</span>
                          <span className="tabular-nums">{moneyCents(inv.total_cents, inv.currency)}</span>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {inv.status !== "paid" && inv.status !== "void" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={markInvoice.isPending}
                            onClick={() => markInvoice.mutate({ id: inv.id, status: "paid" })}
                          >
                            {t("billing2.markPaid", { defaultValue: "標記已付款" })}
                          </Button>
                        )}
                        {inv.status !== "void" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={markInvoice.isPending}
                            onClick={() => markInvoice.mutate({ id: inv.id, status: "void" })}
                          >
                            {t("billing2.markVoid", { defaultValue: "作廢" })}
                          </Button>
                        )}
                        {/* code-ready:PDF 下載待接上產生器 / 外部依賴後啟用 */}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled
                          title={t("billing2.pdfComingSoon", { defaultValue: "PDF 下載即將推出(需接上產生器)" })}
                        >
                          <Download className="h-4 w-4" /> {t("billing2.downloadPdf", { defaultValue: "下載 PDF" })}
                        </Button>
                        {inv.stripe_invoice_id && (
                          <span className="text-[11px] text-muted-foreground">Stripe: {inv.stripe_invoice_id}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-80 w-full" />
          ))}
        </div>
      ) : (
        <>
          {/* 方案對照 */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {sortedPlans.map((p) => {
              const Icon = PLAN_ICON[p.code] ?? Gift;
              const isCurrent = p.id === currentPlanId;
              const highlight = p.code === "pro";
              const planPrice = p.price_monthly || p.price_cents || 0;
              // 付費方案且比目前生效方案更貴 → 屬「升級」,必須走結帳付款,不提供免費即時切換。
              const requiresPayment = !isCurrent && planPrice > 0 && planPrice > currentPrice;
              return (
                <Card
                  key={p.id}
                  className={cn(
                    "flex flex-col",
                    isCurrent ? "border-brand ring-2 ring-brand" : highlight ? "border-brand/40" : "",
                  )}
                >
                  <CardHeader className="gap-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Icon className="h-5 w-5 text-brand" />
                        <CardTitle className="text-base">{p.name}</CardTitle>
                      </div>
                      {isCurrent && <Badge variant="brand">{t("modules.billing.current")}</Badge>}
                    </div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold">{price(p.price_monthly)}</span>
                      {!!p.price_monthly && <span className="text-xs text-muted-foreground">{t("modules.billing.perMonth")}</span>}
                    </div>
                    {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-3">
                    <ul className="flex-1 space-y-1.5">
                      {catalogKeys.map((key) => {
                        const meta = catalog[key];
                        const info = featureLabel(resolveFeatureValue(p.features, key, meta.default));
                        return (
                          <li key={key} className="flex items-center gap-2 text-xs">
                            {info.on ? (
                              <Check className="h-3.5 w-3.5 shrink-0 text-success" />
                            ) : (
                              <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                            )}
                            <span className={cn("flex-1", !info.on && "text-muted-foreground/60")}>{meta.name}</span>
                            {meta.type === "limit" && <span className="text-muted-foreground">{info.text}</span>}
                          </li>
                        );
                      })}
                    </ul>
                    {/* 單一主要動作:當前方案→使用中;需付款升級→前往結帳;免費 / 降級→直接切換 */}
                    {isCurrent ? (
                      <Button variant="outline" disabled>
                        {t("modules.billing.inUse")}
                      </Button>
                    ) : requiresPayment ? (
                      // 需付款的升級:唯一入口為 Stripe 託管結帳(付款成功由 webhook 生效);
                      // 不提供免費即時切換的按鈕,避免繞過付款直接解鎖付費旗艦。
                      <Button
                        variant="default"
                        disabled={checkingOut !== null}
                        onClick={() => startCheckout(p)}
                      >
                        {checkingOut === p.id ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />{" "}
                            {t("billing.checkoutRedirecting", { defaultValue: "前往結帳…" })}
                          </>
                        ) : (
                          <>
                            <CreditCard className="h-4 w-4" />{" "}
                            {t("billing.subscribeUpgrade", { defaultValue: "訂閱 / 升級" })}
                          </>
                        )}
                      </Button>
                    ) : (
                      // 免費方案或降級 / 同級付費:可直接切換(後端付款門檻亦放行)。
                      <Button
                        variant="default"
                        disabled={switching !== null}
                        onClick={() => switchPlan(p)}
                      >
                        {switching === p.id ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" /> {t("modules.billing.switching")}
                          </>
                        ) : (
                          t("modules.billing.switchTo", { name: p.name })
                        )}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* 目前功能解鎖狀態 */}
          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="text-sm">{t("modules.billing.activeFeatures")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {catalogKeys.map((key) => {
                  const meta = catalog[key];
                  const info = featureLabel(resolveFeatureValue(currentFeatures, key, meta.default));
                  return (
                    <div
                      key={key}
                      className="flex items-start gap-2 rounded-md border border-border p-2.5"
                    >
                      {info.on ? (
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                      ) : (
                        <X className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/40" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{meta.name}</span>
                          {meta.type === "limit" && <Badge variant="secondary">{info.text}</Badge>}
                        </div>
                        <p className="text-[11px] text-muted-foreground">{meta.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </PageShell>
  );
}
