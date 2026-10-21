import {
  Globe,
  Send,
  MessageCircle,
  MessageSquare,
  Mail,
  MessagesSquare,
  Facebook,
  Hash,
  type LucideIcon,
} from "lucide-react";
import i18n from "@/lib/i18n";
import type { AgentStatus, ChannelType } from "@/types";

/**
 * channelMeta 的鍵:除了 @/types 的 ChannelType,另補後端會回、但型別檔尚未列入的
 * facebook / line(見 adapters.ts 的 KnownChannel);否則這些渠道會落到 fallback 而被
 * 當成 web(地球圖示),工作台/渠道頁無法正確辨識(產品審計確認的 bug)。
 */
export type ChannelMetaKey = ChannelType | "facebook" | "line";

export const channelMeta: Record<ChannelMetaKey, { label: string; Icon: LucideIcon; color: string }> = {
  web: { get label() { return i18n.t("misc.channelWeb"); }, Icon: Globe, color: "text-info" },
  telegram: { label: "Telegram", Icon: Send, color: "text-[hsl(200_80%_50%)]" },
  whatsapp: { label: "WhatsApp", Icon: MessageCircle, color: "text-success" },
  facebook: { label: "Facebook", Icon: Facebook, color: "text-[hsl(214_89%_52%)]" },
  line: { label: "LINE", Icon: MessageSquare, color: "text-[hsl(145_63%_42%)]" },
  wechat: { get label() { return i18n.t("misc.channelWechat"); }, Icon: MessagesSquare, color: "text-success" },
  email: { label: "Email", Icon: Mail, color: "text-warning" },
  slack: { label: "Slack", Icon: Hash, color: "text-brand" },
  discord: { label: "Discord", Icon: Hash, color: "text-brand" },
};

export const agentStatusMeta: Record<AgentStatus, { label: string; dot: string }> = {
  online: { get label() { return i18n.t("misc.agentStatusOnline"); }, dot: "bg-status-online" },
  busy: { get label() { return i18n.t("misc.agentStatusBusy"); }, dot: "bg-status-busy" },
  away: { get label() { return i18n.t("misc.agentStatusAway"); }, dot: "bg-status-away" },
  offline: { get label() { return i18n.t("misc.agentStatusOffline"); }, dot: "bg-status-offline" },
};
