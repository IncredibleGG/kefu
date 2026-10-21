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

export interface SecondaryItem {
  labelKey?: string;
  label?: string;
  to: string;
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
}

export const navItems: NavItem[] = [
  {
    key: "dashboard",
    labelKey: "nav.dashboard",
    icon: Gauge,
    to: "/dashboard",
    roles: ["admin", "supervisor"],
    secondary: [], // 總覽=單頁儀表板
  },
  {
    key: "workspace",
    labelKey: "nav.workspace",
    icon: LayoutDashboard,
    to: "/workspace",
    secondary: [], // 工作台=三欄,無需二級欄
  },
  {
    key: "visitors",
    labelKey: "nav.visitors",
    icon: Users,
    to: "/visitors",
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
      { labelKey: "nav.sub.settings.profile", label: "個人", to: "/settings?tab=profile" },
      { labelKey: "nav.sub.settings.twofa", label: "兩步驗證 (2FA)", to: "/settings?tab=2fa" },
      { labelKey: "nav.sub.settings.staff", label: "團隊 / 坐席", to: "/settings?tab=staff" },
      { labelKey: "nav.sub.settings.rbac", label: "角色權限 (RBAC)", to: "/settings?tab=rbac" },
      { labelKey: "nav.sub.settings.security", label: "安全政策", to: "/settings?tab=security" },
      { labelKey: "nav.sub.settings.sso", label: "企業 SSO", to: "/settings?tab=sso" },
      { labelKey: "nav.sub.settings.audit", label: "稽核日誌", to: "/settings?tab=audit" },
      { labelKey: "nav.sub.settings.skills", label: "技能組", to: "/settings?tab=skills" },
      { labelKey: "nav.sub.settings.schedule", label: "排班", to: "/settings?tab=schedule" },
      { labelKey: "nav.sub.settings.canned", label: "快捷回覆", to: "/settings?tab=canned" },
      { labelKey: "nav.sub.settings.macros", label: "巨集", to: "/settings?tab=macros" },
      { labelKey: "nav.sub.settings.widget", label: "Widget 與接待", to: "/settings?tab=widget" },
      { labelKey: "nav.sub.settings.translate", label: "翻譯設定", to: "/settings?tab=translate" },
      { labelKey: "nav.sub.settings.tags", label: "標籤管理", to: "/settings?tab=tags" },
      { labelKey: "nav.sub.settings.llm", label: "模型供應商", to: "/settings?tab=llm" },
      { labelKey: "nav.sub.settings.automation", label: "自動化規則", to: "/settings?tab=automation" },
      { labelKey: "nav.sub.settings.proactive", label: "主動式訊息", to: "/settings?tab=proactive" },
      { labelKey: "nav.sub.settings.goals", label: "目標 / 銷售", to: "/settings?tab=goals" },
      { labelKey: "nav.sub.settings.sla", label: "SLA 政策", to: "/settings?tab=sla" },
      { labelKey: "nav.sub.settings.email", label: "Email 渠道", to: "/settings?tab=email" },
      { labelKey: "nav.sub.settings.meta", label: "WhatsApp / Facebook", to: "/settings?tab=meta" },
      { labelKey: "nav.sub.settings.integrations", label: "整合 / 插件", to: "/settings?tab=integrations" },
      { labelKey: "nav.sub.settings.webhooks", label: "Webhook 管理", to: "/settings?tab=webhooks" },
      { labelKey: "nav.sub.settings.apikeys", label: "開放 API 金鑰", to: "/settings?tab=apikeys" },
      { labelKey: "nav.sub.settings.helpcenter", label: "Help Center 發布", to: "/settings?tab=helpcenter" },
      { labelKey: "nav.sub.settings.brand", label: "品牌 / 外觀", to: "/settings?tab=brand" },
      { labelKey: "nav.sub.settings.domains", label: "自訂網域", to: "/settings?tab=domains" },
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
