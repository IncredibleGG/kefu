import {
  LayoutDashboard,
  Gauge,
  Users,
  Ticket,
  Waypoints,
  Bot,
  BookOpen,
  Radio,
  BarChart3,
  Network,
  Building,
  Building2,
  Settings,
  CreditCard,
  type LucideIcon,
} from "lucide-react";
import type { TFunction } from "i18next";

export interface SecondaryItem {
  labelKey?: string;
  label?: string;
  to: string;
  /** 手機版分組(目前僅設定區使用):MobileSecondaryNav 底部清單 / MobileNavDrawer 依此分段 */
  group?: SecondaryGroupKey;
}

export interface NavItem {
  key: string;
  labelKey: string; // i18n key: nav.<x>
  icon: LucideIcon;
  to: string;
  /** 可見角色(空=全部);與 staff.roles 取交集 */
  roles?: string[];
  /** 二級側欄項目(空=該區無二級欄,例如工作台本身即三欄) */
  secondary?: SecondaryItem[];
  /** 手機底部分頁列的格位(1 起算;同格位多項時取第一個角色可見者,例如第 4 格:總覽 / 知識庫) */
  mobileTab?: number;
  /** 手機底部分頁列用的短標籤(缺省沿用 labelKey) */
  mobileLabelKey?: string;
  mobileLabel?: string;
  /** 頁面本身已有分頁列:手機版不另外顯示二級 chip 列 */
  inPageTabs?: boolean;
}

export const navItems: NavItem[] = [
  {
    key: "dashboard",
    labelKey: "nav.dashboard",
    icon: Gauge,
    to: "/dashboard",
    mobileTab: 4,
    roles: ["admin", "supervisor"],
    secondary: [], // 總覽=單頁儀表板
  },
  {
    key: "workspace",
    labelKey: "nav.workspace",
    icon: LayoutDashboard,
    to: "/workspace",
    mobileTab: 1,
    secondary: [], // 工作台=三欄,無需二級欄
  },
  {
    key: "visitors",
    labelKey: "nav.visitors",
    icon: Users,
    to: "/visitors",
    mobileTab: 3,
    mobileLabelKey: "mobile.tab.visitors",
    mobileLabel: "訪客",
    secondary: [
      { labelKey: "nav.sub.visitors.list", label: "訪客名單", to: "/visitors" },
      { labelKey: "nav.sub.visitors.contacts", label: "客戶檔案", to: "/visitors?tab=contacts" },
      { labelKey: "nav.sub.visitors.tags", label: "標籤分群", to: "/visitors?tab=tags" },
    ],
  },
  {
    key: "company",
    labelKey: "nav.company",
    icon: Building,
    to: "/company",
    secondary: [],
  },
  {
    key: "tickets",
    labelKey: "nav.tickets",
    icon: Ticket,
    to: "/tickets",
    mobileTab: 2,
    secondary: [], // 單頁,篩選走頁內狀態
  },
  {
    key: "routing",
    labelKey: "nav.routing",
    icon: Waypoints,
    to: "/routing",
    roles: ["admin", "supervisor"],
    secondary: [],
  },
  {
    key: "ai",
    labelKey: "nav.ai",
    icon: Bot,
    to: "/ai",
    inPageTabs: true,
    secondary: [
      { labelKey: "nav.sub.ai.agents", label: "AI 代理", to: "/ai?tab=agents" },
      { labelKey: "nav.sub.ai.tools", label: "工具 / MCP", to: "/ai?tab=tools" },
      { labelKey: "nav.sub.ai.workflows", label: "工作流", to: "/ai?tab=workflows" },
      { labelKey: "nav.sub.ai.playground", label: "對話測試", to: "/ai?tab=playground" },
    ],
  },
  {
    key: "knowledge",
    labelKey: "nav.knowledge",
    icon: BookOpen,
    to: "/knowledge",
    mobileTab: 4,
    inPageTabs: true,
    secondary: [
      { labelKey: "nav.sub.knowledge.list", label: "知識庫列表", to: "/knowledge" },
      { labelKey: "nav.sub.knowledge.import", label: "匯入", to: "/knowledge?tab=import" },
      { labelKey: "nav.sub.knowledge.hits", label: "命中分析", to: "/knowledge?tab=hits" },
    ],
  },
  {
    key: "channels",
    labelKey: "nav.channels",
    icon: Radio,
    to: "/channels",
    roles: ["admin"],
    secondary: [
      { labelKey: "nav.sub.channels.web", label: "網頁掛件", to: "/channels?type=web" },
      { labelKey: "nav.sub.channels.telegram", label: "Telegram", to: "/channels?type=telegram" },
      { labelKey: "nav.sub.channels.whatsapp", label: "WhatsApp", to: "/channels?type=whatsapp" },
      { labelKey: "nav.sub.channels.email", label: "Email", to: "/channels?type=email" },
    ],
  },
  {
    key: "reports",
    labelKey: "nav.reports",
    icon: BarChart3,
    to: "/reports",
    inPageTabs: true,
    roles: ["admin", "supervisor"],
    secondary: [
      { labelKey: "nav.sub.reports.overview", label: "總覽", to: "/reports" },
      { labelKey: "nav.sub.reports.agents", label: "坐席績效", to: "/reports?tab=agents" },
      { labelKey: "nav.sub.reports.satisfaction", label: "滿意度 / 質檢", to: "/reports?tab=satisfaction" },
      { labelKey: "nav.sub.reports.monitor", label: "坐席即時監控", to: "/reports?tab=monitor" },
      { labelKey: "nav.sub.reports.insights", label: "AI 洞察", to: "/reports?tab=insights" },
      { labelKey: "nav.sub.reports.sales", label: "銷售", to: "/reports?tab=sales" },
      { labelKey: "nav.sub.reports.activity", label: "工時 / 活動", to: "/reports?tab=activity" },
    ],
  },
  {
    key: "organization",
    labelKey: "nav.organization",
    icon: Network,
    to: "/organization",
    roles: ["admin"],
    secondary: [],
  },
  {
    key: "settings",
    labelKey: "nav.settings",
    icon: Settings,
    to: "/settings",
    roles: ["admin"],
    secondary: [
      { labelKey: "nav.sub.settings.profile", label: "個人", to: "/settings?tab=profile", group: "account" },
      { labelKey: "nav.sub.settings.twofa", label: "兩步驗證 (2FA)", to: "/settings?tab=2fa", group: "account" },
      { labelKey: "nav.sub.settings.staff", label: "團隊 / 坐席", to: "/settings?tab=staff", group: "team" },
      { labelKey: "nav.sub.settings.rbac", label: "角色權限 (RBAC)", to: "/settings?tab=rbac", group: "team" },
      { labelKey: "nav.sub.settings.security", label: "安全政策", to: "/settings?tab=security", group: "team" },
      { labelKey: "nav.sub.settings.sso", label: "企業 SSO", to: "/settings?tab=sso", group: "team" },
      { labelKey: "nav.sub.settings.audit", label: "稽核日誌", to: "/settings?tab=audit", group: "team" },
      { labelKey: "nav.sub.settings.skills", label: "技能組", to: "/settings?tab=skills", group: "team" },
      { labelKey: "nav.sub.settings.schedule", label: "排班", to: "/settings?tab=schedule", group: "team" },
      { labelKey: "nav.sub.settings.canned", label: "快捷回覆", to: "/settings?tab=canned", group: "conversation" },
      { labelKey: "nav.sub.settings.macros", label: "巨集", to: "/settings?tab=macros", group: "conversation" },
      { labelKey: "nav.sub.settings.widget", label: "Widget 與接待", to: "/settings?tab=widget", group: "channels" },
      { labelKey: "nav.sub.settings.translate", label: "翻譯設定", to: "/settings?tab=translate", group: "ai" },
      { labelKey: "nav.sub.settings.tags", label: "標籤管理", to: "/settings?tab=tags", group: "conversation" },
      { labelKey: "nav.sub.settings.llm", label: "模型供應商", to: "/settings?tab=llm", group: "ai" },
      { labelKey: "nav.sub.settings.automation", label: "自動化規則", to: "/settings?tab=automation", group: "conversation" },
      { labelKey: "nav.sub.settings.proactive", label: "主動式訊息", to: "/settings?tab=proactive", group: "conversation" },
      { labelKey: "nav.sub.settings.goals", label: "目標 / 銷售", to: "/settings?tab=goals", group: "team" },
      { labelKey: "nav.sub.settings.sla", label: "SLA 政策", to: "/settings?tab=sla", group: "conversation" },
      { labelKey: "nav.sub.settings.email", label: "Email 渠道", to: "/settings?tab=email", group: "channels" },
      { labelKey: "nav.sub.settings.meta", label: "WhatsApp / Facebook", to: "/settings?tab=meta", group: "channels" },
      { labelKey: "nav.sub.settings.integrations", label: "整合 / 插件", to: "/settings?tab=integrations", group: "advanced" },
      { labelKey: "nav.sub.settings.webhooks", label: "Webhook 管理", to: "/settings?tab=webhooks", group: "advanced" },
      { labelKey: "nav.sub.settings.apikeys", label: "開放 API 金鑰", to: "/settings?tab=apikeys", group: "advanced" },
      { labelKey: "nav.sub.settings.helpcenter", label: "Help Center 發布", to: "/settings?tab=helpcenter", group: "channels" },
      { labelKey: "nav.sub.settings.brand", label: "品牌 / 外觀", to: "/settings?tab=brand", group: "advanced" },
      { labelKey: "nav.sub.settings.domains", label: "自訂網域", to: "/settings?tab=domains", group: "advanced" },
    ],
  },
  {
    key: "billing",
    labelKey: "nav.billing",
    icon: CreditCard,
    to: "/billing",
    roles: ["admin"],
    secondary: [],
  },
  {
    key: "reseller",
    labelKey: "nav.reseller",
    icon: Building2,
    to: "/reseller",
    roles: ["admin", "reseller"],
    secondary: [],
  },
];

/** 依角色過濾一級導覽 */
export function visibleNav(roles: string[]): NavItem[] {
  return navItems.filter((n) => !n.roles || n.roles.some((r) => roles.includes(r)));
}

/* ------------------------------ 手機版面(< md)用 ------------------------------ */

/** 二級項目分組鍵(設定區 27 項在手機上以分組清單呈現) */
export type SecondaryGroupKey = "account" | "team" | "conversation" | "ai" | "channels" | "advanced";

/** 分組顯示順序與標籤(labelKey 供 i18n;label 為繁中預設) */
export const SECONDARY_GROUPS: { key: SecondaryGroupKey; labelKey: string; label: string }[] = [
  { key: "account", labelKey: "mobile.group.account", label: "帳號" },
  { key: "team", labelKey: "mobile.group.team", label: "團隊" },
  { key: "conversation", labelKey: "mobile.group.conversation", label: "對話" },
  { key: "ai", labelKey: "mobile.group.ai", label: "AI" },
  { key: "channels", labelKey: "mobile.group.channels", label: "渠道" },
  { key: "advanced", labelKey: "mobile.group.advanced", label: "進階" },
];

/** 把二級項目依 group 分段(保留 SECONDARY_GROUPS 順序;未分組者歸到最後一段,key 為 null)。 */
export function groupSecondary(
  items: SecondaryItem[],
): { key: SecondaryGroupKey | null; labelKey?: string; label?: string; items: SecondaryItem[] }[] {
  const out: { key: SecondaryGroupKey | null; labelKey?: string; label?: string; items: SecondaryItem[] }[] = [];
  for (const g of SECONDARY_GROUPS) {
    const hit = items.filter((i) => i.group === g.key);
    if (hit.length) out.push({ key: g.key, labelKey: g.labelKey, label: g.label, items: hit });
  }
  const rest = items.filter((i) => !i.group);
  if (rest.length) out.push({ key: null, items: rest });
  return out;
}

/** 手機底部分頁列:依 mobileTab 格位排序;同格位只取第一個角色可見者(navItems 順序)。 */
export function mobileTabItems(roles: string[]): NavItem[] {
  const bySlot = new Map<number, NavItem>();
  for (const n of visibleNav(roles)) {
    if (n.mobileTab != null && !bySlot.has(n.mobileTab)) bySlot.set(n.mobileTab, n);
  }
  return [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
}

/** 依路徑找出所屬一級區塊(與 AppLayout / IconRail 相同的 startsWith 規則) */
export function sectionForPath(pathname: string): NavItem {
  return navItems.find((n) => pathname.startsWith(n.to)) ?? navItems[0];
}

/** 二級項目顯示名稱:labelKey 優先,缺鍵時退回硬編 label,再退回路徑(與 SecondarySidebar 一致)。 */
export function secondaryLabel(item: SecondaryItem, t: TFunction): string {
  return item.labelKey ? t(item.labelKey, { defaultValue: item.label ?? item.to }) : (item.label ?? item.to);
}

/** 二級項目是否為目前位置:pathname + search 完全相等(與 SecondarySidebar 一致);
 *  項目帶查詢參數時,目前網址另含其他參數(例如 ?tab=staff&id=…)也算命中。 */
export function isSecondaryActive(item: SecondaryItem, pathname: string, search: string): boolean {
  if (pathname + search === item.to) return true;
  const q = item.to.indexOf("?");
  if (q < 0 || item.to.slice(0, q) !== pathname) return false;
  const want = new URLSearchParams(item.to.slice(q + 1));
  const have = new URLSearchParams(search);
  for (const [k, v] of want) if (have.get(k) !== v) return false;
  return true;
}
