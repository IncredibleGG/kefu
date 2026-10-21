import { useTranslation } from "react-i18next";
import {
  Copy,
  Flag,
  Quote,
  Languages,
  BookMarked,
  Bot,
  Check,
  CheckCheck,
  ShieldCheck,
  Paperclip,
  StickyNote,
  ExternalLink,
  MessageSquare,
  Zap,
} from "lucide-react";
import { cn, hhmm } from "@/lib/utils";
import { renderMarkdown } from "@/lib/markdown";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Message } from "@/types";

/** 附件連結安全檢查:僅允許 http(s):// 或本站相對路徑(單一開頭斜線),
 *  擋掉 javascript: / data: / 協定相對(//host)等,避免點擊圖片 / 檔案連結觸發 XSS。 */
function isSafeUrl(u: string): boolean {
  if (!u) return false;
  if (/^https?:\/\//i.test(u)) return true;
  if (/^\/(?!\/)/.test(u)) return true;
  return false;
}

/** 單則訊息:左右氣泡 + 系統事件 + hover 訊息級操作(含質檢標旗) */
export function MessageBubble({
  message,
  onFlag,
  onQuote,
  readState,
}: {
  message: Message;
  onFlag: (flagged: boolean) => void;
  /** 引用此訊息:把內容帶入輸入框(由 ConversationView 注入草稿)。未提供則不顯示引用鈕。 */
  onQuote?: (content: string) => void;
  /** 坐席送出訊息的送達/已讀狀態(由 ConversationView 依 read_at 浮水印推導);
   *  未提供時回退 message.status。僅對非訪客(己方 human/ai)氣泡呈現。 */
  readState?: "delivered" | "read";
}) {
  const { t } = useTranslation();

  // 內部備註:黃底卡片 + 明顯標籤,與對客訊息明確區分(僅坐席可見)
  if (message.sender_type === "note") {
    return (
      <div className="my-1.5 flex justify-center px-1">
        <div className="w-full max-w-[88%] rounded-md border border-warning/40 border-dashed bg-warning/10 px-3 py-2">
          <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-warning">
            <StickyNote className="h-3 w-3" />
            {t("workspace.messageBubble.internalNote")}
            <span className="ml-auto font-normal text-muted-foreground">{hhmm(message.ts)}</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">{message.content}</p>
        </div>
      </div>
    );
  }

  // 系統事件:置中細灰條
  if (message.sender_type === "system") {
    return (
      <div className="my-2 flex justify-center">
        <span className="rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground">
          {message.content}
        </span>
      </div>
    );
  }

  const isVisitor = message.sender_type === "visitor";
  const isAi = message.sender_type === "ai";
  // 富卡片清單(輪播):多張走 meta.cards、單張走 meta.card,皆無則空陣列(落純文字回退)。
  const cardList = message.content_type === "card" ? getCards(message) : [];

  return (
    <div className={cn("group flex gap-2 px-1", isVisitor ? "justify-start" : "justify-end")}>
      <div className={cn("flex max-w-[76%] flex-col", isVisitor ? "items-start" : "items-end")}>
        {/* 傳送者標籤 */}
        <div className="mb-0.5 flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
          {isAi && <Bot className="h-3 w-3 text-brand" />}
          <span>{message.sender_name ?? (isVisitor ? t("workspace.messageBubble.visitor") : t("workspace.messageBubble.me"))}</span>
          <span>· {hhmm(message.ts)}</span>
          {message.flagged && (
            <SimpleTooltip label={t("workspace.messageBubble.flaggedForReview")} side="top">
              <Flag className="h-3 w-3 fill-warning text-warning" />
            </SimpleTooltip>
          )}
        </div>

        <div className={cn("flex items-end gap-1", isVisitor ? "flex-row" : "flex-row-reverse")}>
          {/* 氣泡 */}
          <div
            className={cn(
              "rounded-lg px-3 py-2 text-sm shadow-sm",
              isVisitor
                ? "rounded-tl-sm bg-muted text-foreground"
                : isAi
                  ? "rounded-tr-sm border border-brand/30 bg-brand/10 text-foreground"
                  : "rounded-tr-sm bg-brand text-brand-foreground",
            )}
          >
            {message.i18n ? (
              <TranslatedContent i18n={message.i18n} />
            ) : message.content_type === "markdown" ? (
              <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
            ) : message.content_type === "card" && cardList.length > 0 ? (
              // 富卡片:多張(meta.cards)→ 橫向輪播;單張(meta.card)→ 現狀單卡。
              // 缺卡片資料(如歷史降級)時落到最末純文字分支,以 content 當可讀回退。
              <RichCardGroup cards={cardList} />
            ) : message.content_type === "image" ? (
              <ImageContent url={message.content} />
            ) : message.content_type === "file" ? (
              <FileContent url={message.content} />
            ) : (
              <span className="whitespace-pre-wrap break-words">{message.content}</span>
            )}

            {/* AI 溯源與信心 */}
            {isAi && message.ai && (
              <div className="mt-2 border-t border-brand/20 pt-1.5 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3 text-success" />
                  {t("workspace.messageBubble.confidence", { percent: Math.round(message.ai.confidence * 100) })}
                </div>
                {message.ai.sources.map((src) => (
                  <div key={src.ref} className="mt-0.5 flex items-center gap-1">
                    <BookMarked className="h-3 w-3" />
                    <span className="truncate">{src.title}</span>
                    <Badge variant="secondary" className="px-1 py-0">
                      {Math.round(src.score * 100)}%
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* hover 訊息級操作 */}
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <MsgAction label={t("panel.search")} onClick={() => navigator.clipboard?.writeText(message.content)}>
              <Copy className="h-3.5 w-3.5" />
            </MsgAction>
            {onQuote && (
              <MsgAction label={t("workspace.messageBubble.quote")} onClick={() => onQuote(message.content)}>
                <Quote className="h-3.5 w-3.5" />
              </MsgAction>
            )}
            <MsgAction
              label={message.flagged ? t("workspace.messageBubble.unflag") : t("workspace.messageBubble.flag")}
              active={message.flagged}
              onClick={() => onFlag(!message.flagged)}
            >
              <Flag className={cn("h-3.5 w-3.5", message.flagged && "fill-warning text-warning")} />
            </MsgAction>
          </div>
        </div>

        {/* 訊息狀態:優先用 read_at 推導的 readState(已送達/已讀),否則回退 message.status */}
        {(() => {
          const st = readState ?? message.status;
          if (isVisitor || !st) return null;
          return (
            <span className="mt-0.5 flex items-center gap-0.5 px-1 text-[10px] text-muted-foreground">
              {st === "read" ? (
                <CheckCheck className="h-3 w-3 text-info" />
              ) : st === "delivered" ? (
                <Check className="h-3 w-3" />
              ) : null}
              {st === "read"
                ? t("workspace.messageBubble.read")
                : st === "delivered"
                  ? t("workspace.messageBubble.delivered")
                  : st}
            </span>
          );
        })()}
      </div>
    </div>
  );
}

function MsgAction({
  label,
  children,
  onClick,
  active,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <SimpleTooltip label={label} side="top">
      <Button variant="ghost" size="icon-sm" className={cn("h-7 w-7", active && "text-warning")} onClick={onClick}>
        {children}
      </Button>
    </SimpleTooltip>
  );
}

/** 雙向翻譯訊息:原文在上、譯文在下(較淡樣式 + 「譯」標籤)。 */
function TranslatedContent({ i18n }: { i18n: NonNullable<Message["i18n"]> }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      {/* 原文 */}
      <span className="whitespace-pre-wrap break-words">{i18n.original}</span>
      {/* 譯文(較淡 + 「譯」標籤) */}
      <div className="mt-0.5 flex items-start gap-1 border-t border-current/15 pt-1.5">
        <Badge variant="secondary" className="mt-px shrink-0 gap-0.5 px-1 py-0 text-[10px] opacity-80">
          <Languages className="h-2.5 w-2.5" />{t("workspace.messageBubble.translatedTag")}
        </Badge>
        <span className="whitespace-pre-wrap break-words text-[13px] italic opacity-70">
          {i18n.translated}
        </span>
      </div>
    </div>
  );
}

/** 圖片訊息:content 為圖片 URL。非法連結協定則退回純文字顯示,不渲染為可點連結 / 圖片。 */
function ImageContent({ url }: { url: string }) {
  const { t } = useTranslation();
  if (!isSafeUrl(url)) {
    return <span className="whitespace-pre-wrap break-words">{url}</span>;
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block">
      <img
        src={url}
        alt={t("workspace.messageBubble.imageAlt")}
        className="max-h-60 max-w-full rounded-md object-contain"
        loading="lazy"
      />
    </a>
  );
}

/** 檔案訊息:content 為檔案 URL,顯示檔名連結。非法連結協定則退回純文字顯示,不渲染為可點連結。 */
function FileContent({ url }: { url: string }) {
  if (!isSafeUrl(url)) {
    return <span className="whitespace-pre-wrap break-words">{url}</span>;
  }
  let name = url;
  try {
    const p = new URL(url, window.location.href).pathname;
    name = decodeURIComponent(p.split("/").pop() || url);
  } catch {
    name = url.split("/").pop() || url;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 underline underline-offset-2"
    >
      <Paperclip className="h-3.5 w-3.5 shrink-0" />
      <span className="break-all">{name}</span>
    </a>
  );
}

/** 富卡片 meta 契約(對齊 widget 與 send 端):
 *  meta.card = { title?, text?, image_url?, buttons:[{label, url? , reply?, postback?}] }。 */
interface RichCardButton {
  label?: string;
  url?: string;
  reply?: string;
  postback?: string;
}
interface RichCardData {
  title?: string;
  text?: string;
  image_url?: string;
  buttons?: RichCardButton[];
}

/**
 * 從訊息取出富卡片清單(輪播 carousel):
 *   - 優先 message.cards(陣列,多張)→ 過濾出物件卡片;
 *   - 否則單張 message.card → 收成單元素陣列(向後相容);
 *   - 皆無 → 空陣列(呼叫端落到純文字回退)。
 * 註:adapters.mapMessage 目前僅把 meta.card 映射到 message.card(未映射 meta.cards),
 *     故坐席端歷史重整 / WS-only 收訊時多卡會降級為 content 純文字回退;
 *     欲讓多卡於歷史還原,需主 session 於 adapters.mapMessage 一併映射 cards(見回報)。
 *     剛送出的多卡由 MessageComposer 樂觀補上 cards 欄位,故即時呈現不受影響。
 */
function getCards(message: Message): RichCardData[] {
  const m = message as unknown as { card?: RichCardData; cards?: RichCardData[] };
  if (Array.isArray(m.cards) && m.cards.length) {
    return m.cards.filter((c): c is RichCardData => !!c && typeof c === "object");
  }
  if (m.card && typeof m.card === "object") return [m.card];
  return [];
}

/** 富卡片群組:多張 → 橫向可捲動輪播(每卡沿用 RichCard);單張 → 直接渲染單卡。 */
function RichCardGroup({ cards }: { cards: RichCardData[] }) {
  if (cards.length >= 2) {
    return (
      <div className="-mx-1 flex max-w-[min(72vw,560px)] gap-2 overflow-x-auto px-1 pb-1 [scroll-snap-type:x_mandatory]">
        {cards.map((c, i) => (
          <div key={i} className="shrink-0 [scroll-snap-align:start]">
            <RichCard card={c} />
          </div>
        ))}
      </div>
    );
  }
  return <RichCard card={cards[0]} />;
}

/** 坐席端卡片渲染:標題 / 文字 / 圖 / 按鈕。
 *  - url 按鈕:僅 http(s)(沿用 isSafeUrl 白名單,擋 javascript:)→ 開新分頁。
 *  - reply 按鈕:坐席端為「預覽」(quick reply 由訪客端點擊時才送出),此處僅呈現不觸發。 */
function RichCard({ card }: { card: RichCardData }) {
  const { t } = useTranslation();
  const buttons = Array.isArray(card.buttons) ? card.buttons : [];
  return (
    <div className="w-60 overflow-hidden rounded-md border border-border bg-card text-foreground">
      {card.image_url && isSafeUrl(card.image_url) && (
        <img
          src={card.image_url}
          alt={card.title ?? ""}
          className="h-32 w-full object-cover"
          loading="lazy"
        />
      )}
      {(card.title || card.text) && (
        <div className="space-y-1 p-2.5">
          {card.title && <p className="text-sm font-semibold">{card.title}</p>}
          {card.text && (
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{card.text}</p>
          )}
        </div>
      )}
      {buttons.length > 0 && (
        <div className="flex flex-col border-t border-border">
          {buttons.map((b, i) => {
            const label = b.label || b.url || b.reply || b.postback || "";
            if (b.url && isSafeUrl(b.url)) {
              return (
                <a
                  key={i}
                  href={b.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-1 border-b border-border px-2.5 py-1.5 text-center text-xs font-medium text-brand last:border-b-0 hover:bg-accent"
                >
                  <ExternalLink className="h-3 w-3 shrink-0" />
                  <span className="truncate">{label}</span>
                </a>
              );
            }
            // postback:坐席端僅預覽(訪客端點擊才送出 payload 觸發 bot 流程 / 自動化)
            if (b.postback) {
              return (
                <span
                  key={i}
                  className="flex items-center justify-center gap-1 border-b border-border px-2.5 py-1.5 text-center text-xs font-medium text-muted-foreground last:border-b-0"
                  title={t("workspace.rich.card.postbackPreview", { defaultValue: "Postback(訪客點擊後觸發 bot 流程 / 自動化)" })}
                >
                  <Zap className="h-3 w-3 shrink-0" />
                  <span className="truncate">{label}</span>
                </span>
              );
            }
            // quick reply:坐席端僅預覽(訪客端才會送出)
            return (
              <span
                key={i}
                className="flex items-center justify-center gap-1 border-b border-border px-2.5 py-1.5 text-center text-xs font-medium text-muted-foreground last:border-b-0"
                title={t("workspace.rich.card.replyPreview", { defaultValue: "快捷回覆(訪客點擊後送出)" })}
              >
                <MessageSquare className="h-3 w-3 shrink-0" />
                <span className="truncate">{label}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
