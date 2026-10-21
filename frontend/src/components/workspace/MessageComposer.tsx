import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Paperclip, Smile, Send, Zap, BookOpen, StickyNote, MessageSquare, Search, Loader2, Wand2, PenLine, Sparkles, LayoutTemplate, Plus, Trash2, Link2, Lock, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { cannedApi, knowledgeApi, conversationApi, routingApi } from "@/api/endpoints";
import { apiFetch } from "@/api/client";
import { mapMessage, type RawMessage } from "@/api/adapters";
import { macrosApi, type Macro, type MacroAction } from "@/api/macros";
import { attachmentsApi } from "@/api/attachments";
import { qk } from "@/api/hooks";
import { useAuth } from "@/stores/auth";
import { useNotify } from "@/stores/notify";
import type { Canned, Message, Visitor } from "@/types";

/** 簽名檔本機快取鍵(與 SettingsPage 一致):後端 /auth/me 不回傳 signature,
 *  故坐席簽名以 localStorage 按 staff 分鍵保存,供送訊時附加。 */
function readSignatureCache(staffId: string): string {
  try {
    return localStorage.getItem(`kefu-signature:${staffId}`) ?? "";
  } catch {
    return "";
  }
}
/** 「附加簽名」開關偏好(按 staff 分鍵)。 */
function readSignatureOn(staffId: string): boolean {
  try {
    return localStorage.getItem(`kefu-signature-on:${staffId}`) === "1";
  } catch {
    return false;
  }
}
function writeSignatureOn(staffId: string, on: boolean): void {
  try {
    localStorage.setItem(`kefu-signature-on:${staffId}`, on ? "1" : "0");
  } catch {
    /* 略過 */
  }
}

/** set_status 動作:視為「結束會話」的目標值(其餘狀態無對應後端端點,標為待接)。 */
const CLOSE_STATUS_VALUES = new Set([
  "resolved",
  "closed",
  "close",
  "done",
  "solved",
  "結束",
  "已結束",
  "已解決",
]);

/** 輕量常用 emoji 面板(自建,不引第三方重相依)。 */
const EMOJIS = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🙂",
  "😉", "😊", "😍", "😘", "🤗", "🤔", "😐", "😴",
  "😎", "😭", "😱", "😡", "👍", "👎", "👌", "🙏",
  "👏", "🙌", "💪", "🎉", "✨", "🔥", "❤️", "💯",
  "✅", "❌", "⚠️", "📌", "📎", "💡", "⭐", "🚀",
];

/** 知識庫檢索命中的原始形狀(對齊 rag.retrieve 輸出)。 */
interface RawKbHit {
  content?: string;
  source_ref?: { title?: string; question?: string; collection_id?: string } | null;
  score?: number;
}

/** 連結白名單:僅 http(s)(擋 javascript: / data: 等),供卡片圖片與 url 按鈕驗證。 */
function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test((u || "").trim());
}

/** 卡片建構器的單一按鈕草稿(type 決定 value 語意:
 *  url=開連結 / reply=快捷回覆(以訪客身分送出文字) / postback=送出機器 payload 觸發 bot 流程)。 */
interface CardButtonDraft {
  label: string;
  type: "url" | "reply" | "postback";
  value: string;
}

/** 卡片建構器的單張卡片草稿(輪播:可有多張)。 */
interface CardDraft {
  title: string;
  text: string;
  image: string;
  buttons: CardButtonDraft[];
}

/** 輪播卡片張數上限(對齊 LiveChat 常見上限,亦避免版面過長)。 */
const MAX_CARDS = 10;

/** 新增一張空白卡片草稿。 */
function emptyCard(): CardDraft {
  return { title: "", text: "", image: "", buttons: [] };
}

/** 送出用的卡片契約形狀(url / reply / postback 三型擇一)。 */
type SentCardButton = { label: string; url?: string; reply?: string; postback?: string };
type SentCard = { title?: string; text?: string; image_url?: string; buttons: SentCardButton[] };

/** 把純文字轉為可安全插入 tiptap 的 HTML(轉義特殊字元、換行→<br/>)。 */
function textToHtml(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc.replace(/\r?\n/g, "<br/>");
}

/** 罐頭內容變數替換:把 {{visitor_name}} 等佔位替換為當前訪客 / 坐席資料。 */
function fillVariables(
  content: string,
  vars: Record<string, string | undefined>,
): string {
  return content.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v != null && v !== "" ? v : `{{${key}}}`; // 無對應值時保留佔位,提醒坐席手動補
  });
}

export function MessageComposer({
  onSend,
  onSendNote,
  visitor,
  injectText,
  injectQuote,
  disabled = false,
  disabledHint,
  onReopen,
}: {
  /** 送出對客訊息;回傳 Promise 時,送出成功才會清空輸入框,失敗則保留內容。 */
  onSend: (text: string) => void | Promise<void>;
  /** 送出私密內部備註(僅同事可見);同樣支援回傳 Promise 以判定成敗。 */
  onSendNote?: (text: string) => void | Promise<void>;
  /** 當前會話訪客,用於罐頭變數替換 */
  visitor?: Visitor;
  /** 由 AI 建議條「採用」注入草稿(帶 nonce 觸發);坐席可再編輯後 Enter 送出 */
  injectText?: { text: string; nonce: number };
  /** 引用某則訊息:在游標處插入該訊息文字(帶 nonce 觸發),保留既有草稿 */
  injectQuote?: { text: string; nonce: number };
  /** 禁用輸入(如會話已結束):不渲染輸入框與工具列,改顯示提示與「重新開啟」入口,
   *  從源頭阻止「送訊靜默重開」。 */
  disabled?: boolean;
  /** 禁用時顯示的說明文字。 */
  disabledHint?: string;
  /** 禁用時「重新開啟」按鈕的回呼(通常由上層以 handoff takeover 實作)。 */
  onReopen?: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const staffName = useAuth((s) => s.staff?.display_name);
  const staffId = useAuth((s) => s.staff?.staff_id);
  // 目前開啟中的會話 id(由 ConversationView 進入會話時寫入 notify store)。
  // 附件上傳需綁定會話,而本元件未由父層收到 sessionId,故從此處取用。
  const sessionId = useNotify((s) => s.activeSessionId);
  const [showCanned, setShowCanned] = useState(false);
  const [canned, setCanned] = useState<Canned[]>([]);
  const [noteMode, setNoteMode] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 簽名檔 + 「附加簽名」開關(本機快取;隨登入坐席切換)
  const [signature, setSignature] = useState("");
  const [appendSig, setAppendSig] = useState(false);
  // 巨集面板
  const [showMacros, setShowMacros] = useState(false);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [applyingMacro, setApplyingMacro] = useState(false);
  const [macroMsg, setMacroMsg] = useState<string | null>(null);

  // 工具鈕面板 / 上傳狀態
  const [showEmoji, setShowEmoji] = useState(false);
  const [showKb, setShowKb] = useState(false);
  const [kbQuery, setKbQuery] = useState("");
  const [kbHits, setKbHits] = useState<RawKbHit[]>([]);
  const [kbLoading, setKbLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const kbDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // AI 潤飾:下拉選 action、處理中鎖、失敗提示
  const [showEnhance, setShowEnhance] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);

  // 富卡片建構器(插入卡片/按鈕):支援輪播——多張卡片,每卡各自標題 / 文字 / 圖片 URL + 按鈕。
  const [showCard, setShowCard] = useState(false);
  const [cards, setCards] = useState<CardDraft[]>(() => [emptyCard()]);
  const [activeCard, setActiveCard] = useState(0);
  const [cardError, setCardError] = useState<string | null>(null);
  const [sendingCard, setSendingCard] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: t("workspace.inputPlaceholder") }),
    ],
    editorProps: {
      attributes: { class: "tiptap max-h-40 overflow-y-auto px-3 py-2 text-sm" },
      handleKeyDown: (_view, event) => {
        // IME 組字防護:中文/日文/韓文選字時按 Enter 只是確認候選字,
        // 不可當成送出(對齊 widget 端作法),避免送出半成品。
        if (event.isComposing || event.keyCode === 229) return false;
        // Enter 送出;Shift+Enter 換行
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          send();
          return true;
        }
        return false;
      },
    },
  });

  const text = editor?.getText() ?? "";

  // 罐頭變數對照表(訪客 / 坐席)
  const varMap = useMemo(
    () => ({
      visitor_name: visitor?.display_name,
      visitor_id: visitor?.external_id ?? visitor?.id,
      external_id: visitor?.external_id,
      agent_name: staffName,
      staff_name: staffName,
    }),
    [visitor?.display_name, visitor?.external_id, visitor?.id, staffName],
  );

  // 載入本機簽名檔與「附加簽名」開關(隨登入坐席切換)
  useEffect(() => {
    if (!staffId) {
      setSignature("");
      setAppendSig(false);
      return;
    }
    setSignature(readSignatureCache(staffId));
    setAppendSig(readSignatureOn(staffId));
  }, [staffId]);

  // 輸入以 / 開頭 → 打真 API 依前綴查罐頭(去抖動)
  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      setShowCanned(false);
      return;
    }
    setShowCanned(true);
    const prefix = trimmed.slice(1).trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      cannedApi
        .list({ shortcut_prefix: prefix || undefined })
        .then((rows) => setCanned(rows))
        .catch(() => setCanned([]));
    }, 180);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [text]);

  // 採用 AI 建議 → 注入草稿並聚焦
  useEffect(() => {
    if (injectText && editor) {
      editor.commands.setContent(`<p>${injectText.text}</p>`);
      editor.commands.focus("end");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectText?.nonce]);

  // 引用訊息 → 在游標處插入該訊息文字(以 textToHtml 轉義,避免注入),保留既有草稿並聚焦
  useEffect(() => {
    if (injectQuote && editor && injectQuote.text.trim()) {
      editor.chain().focus().insertContent(textToHtml(injectQuote.text)).run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectQuote?.nonce]);

  // 送出:等待呼叫端回傳的 Promise;成功才清空輸入框,失敗保留內容(錯誤提示由父層呈現)。
  async function send() {
    if (disabled) return; // 已結束會話:禁止送出(避免送訊靜默重開)
    const content = editor?.getText().trim();
    if (!content) return;
    try {
      if (noteMode) {
        await onSendNote?.(content);
      } else {
        // 對客文字回覆:若開啟附加簽名且已設定簽名,於訊息末附加(客端組裝)
        const sig = signature.trim();
        const finalText = appendSig && sig ? `${content}\n\n${sig}` : content;
        await onSend(finalText);
      }
      editor?.commands.clearContent();
      setShowCanned(false);
    } catch {
      // 送出失敗:不清空輸入框,保留內容供重試;提示由 ConversationView 顯示。
    }
  }

  /** 切換「附加簽名」開關並持久化(按 staff 分鍵)。 */
  function toggleAppendSig() {
    setAppendSig((v) => {
      const next = !v;
      if (staffId) writeSignatureOn(staffId, next);
      return next;
    });
  }

  // 開巨集面板時關閉其他;開啟即抓取啟用中的巨集
  function toggleMacros() {
    setShowMacros((v) => {
      const next = !v;
      if (next) {
        setShowEmoji(false);
        setShowKb(false);
        setShowCanned(false);
        setShowEnhance(false);
        setShowCard(false);
        macrosApi
          .list({ is_active: true })
          .then((rows) => setMacros(rows))
          .catch(() => setMacros([]));
      }
      return next;
    });
  }

  /** 套用巨集:回覆型插入輸入框;其餘動作呼叫既有 API(改狀態 / 標籤 / 指派 / 備註),
   *  無對應端點者標為「待接」。無會話時僅套用回覆型。 */
  async function applyMacro(m: Macro) {
    setMacroMsg(null);
    setApplyingMacro(true);
    const applied: string[] = [];
    const pending: string[] = [];
    try {
      // 1) 先合併回覆型,插入輸入框(不自動送出,坐席可再編修)
      const replyText = (m.actions ?? [])
        .filter((a) => a.type === "reply" && a.content)
        .map((a) => fillVariables(a.content ?? "", varMap))
        .join("\n");
      if (replyText) {
        editor?.chain().focus().insertContent(textToHtml(replyText)).run();
        applied.push(t("macros.action.reply", { defaultValue: "插入回覆" }));
      }

      // 2) 其餘動作(需會話)
      for (const a of m.actions ?? []) {
        if (a.type === "reply") continue;
        const label = t(`macros.action.${a.type}`, { defaultValue: a.type });
        if (!sessionId) {
          pending.push(label);
          continue;
        }
        try {
          await applyNonReplyAction(a, sessionId, applied, pending, label);
        } catch {
          pending.push(label);
        }
      }

      if (sessionId) {
        qc.invalidateQueries({ queryKey: ["sessions"] });
        qc.invalidateQueries({ queryKey: qk.messages(sessionId) });
      }

      const parts: string[] = [];
      if (applied.length)
        parts.push(`${t("macros.applied", { defaultValue: "已套用" })}:${applied.join("、")}`);
      if (pending.length)
        parts.push(`${t("macros.pending", { defaultValue: "待接(需手動處理)" })}:${pending.join("、")}`);
      if (!sessionId && pending.length)
        parts.unshift(t("macros.noSession", { defaultValue: "未開啟會話,僅套用回覆內容" }));
      setMacroMsg(parts.join(" · ") || t("macros.applied", { defaultValue: "已套用" }));
    } catch {
      setMacroMsg(t("macros.applyFailed", { defaultValue: "巨集套用失敗" }));
    } finally {
      setApplyingMacro(false);
      setShowMacros(false);
    }
  }

  /** 套用單一非回覆動作;成功推入 applied,無對應端點推入 pending。 */
  async function applyNonReplyAction(
    a: MacroAction,
    sid: string,
    applied: string[],
    pending: string[],
    label: string,
  ) {
    switch (a.type) {
      case "set_status": {
        if (a.value && CLOSE_STATUS_VALUES.has(a.value)) {
          await conversationApi.close(sid);
          applied.push(label);
        } else {
          pending.push(label); // 無「設任意狀態」端點,標為待接
        }
        break;
      }
      case "add_tags": {
        const ids = a.tags ?? [];
        for (const tagId of ids) await conversationApi.applySessionTag(sid, tagId);
        if (ids.length) applied.push(label);
        break;
      }
      case "assign": {
        if (a.staff_id) await routingApi.assignTo(sid, a.staff_id);
        else await conversationApi.handoff(sid, "takeover"); // 未指定 = 接管給自己
        applied.push(label);
        break;
      }
      case "add_note": {
        if (a.content) {
          await conversationApi.addNote(sid, fillVariables(a.content, varMap));
          applied.push(label);
        }
        break;
      }
      default:
        pending.push(label);
    }
  }

  function insertCanned(c: Canned) {
    const filled = fillVariables(c.content, varMap);
    editor?.commands.setContent(`<p>${filled.replace(/\n/g, "<br/>")}</p>`);
    editor?.commands.focus("end");
    setShowCanned(false);
  }

  // 知識庫搜尋(去抖動):輸入時打 /knowledge/retrieve,結果供插入。
  useEffect(() => {
    if (!showKb) return;
    const q = kbQuery.trim();
    if (kbDebounceRef.current) clearTimeout(kbDebounceRef.current);
    if (!q) {
      setKbHits([]);
      setKbLoading(false);
      return;
    }
    setKbLoading(true);
    kbDebounceRef.current = setTimeout(() => {
      knowledgeApi
        .retrieve(q, 6)
        .then((r) => setKbHits(((r as { hits?: RawKbHit[] })?.hits ?? []) as RawKbHit[]))
        .catch(() => setKbHits([]))
        .finally(() => setKbLoading(false));
    }, 250);
    return () => {
      if (kbDebounceRef.current) clearTimeout(kbDebounceRef.current);
    };
  }, [kbQuery, showKb]);

  // 開某面板時關閉其他,避免疊在一起
  function toggleEmoji() {
    setShowEmoji((v) => !v);
    setShowKb(false);
    setShowCanned(false);
    setShowMacros(false);
    setShowEnhance(false);
    setShowCard(false);
  }
  function toggleKb() {
    setShowKb((v) => !v);
    setShowEmoji(false);
    setShowCanned(false);
    setShowMacros(false);
    setShowEnhance(false);
    setShowCard(false);
  }

  function insertEmoji(emoji: string) {
    editor?.chain().focus().insertContent(emoji).run();
  }

  function insertKbHit(hit: RawKbHit) {
    const content = (hit.content ?? "").trim();
    if (content) editor?.chain().focus().insertContent(textToHtml(content)).run();
    setShowKb(false);
    setKbQuery("");
    setKbHits([]);
  }

  // AI 潤飾動作(對齊後端 /ai/enhance 的 action 列舉)
  const ENHANCE_ACTIONS: { key: string; label: string }[] = [
    { key: "expand", label: t("aiassist.enhance.expand", { defaultValue: "擴寫" }) },
    { key: "rephrase", label: t("aiassist.enhance.rephrase", { defaultValue: "改寫" }) },
    { key: "shorten", label: t("aiassist.enhance.shorten", { defaultValue: "精簡" }) },
    { key: "formal", label: t("aiassist.enhance.formal", { defaultValue: "正式語氣" }) },
    { key: "friendly", label: t("aiassist.enhance.friendly", { defaultValue: "親切語氣" }) },
    { key: "fix", label: t("aiassist.enhance.fix", { defaultValue: "修錯字文法" }) },
  ];

  /** 開/關 AI 潤飾下拉;開啟時關閉其他面板。輸入框空時不開。 */
  function toggleEnhance() {
    if (!text.trim()) return;
    setEnhanceError(null);
    setShowEnhance((v) => !v);
    setShowEmoji(false);
    setShowKb(false);
    setShowCanned(false);
    setShowMacros(false);
    setShowCard(false);
  }

  /** 對目前輸入框內容呼叫 /ai/enhance,把回來的文字「替換」輸入框(tiptap setContent,轉義安全)。
   *  處理中鎖;失敗顯示提示、保留原內容。 */
  async function runEnhance(action: string) {
    const content = editor?.getText().trim();
    if (!content || enhancing) return;
    setShowEnhance(false);
    setEnhanceError(null);
    setEnhancing(true);
    try {
      const r = await apiFetch<{ text: string }>("/api/v1/ai/enhance", {
        method: "POST",
        body: { text: content, action },
      });
      const next = (r?.text ?? "").trim();
      if (next) {
        // 以 textToHtml 轉義後 setContent,整段替換輸入框並聚焦末端
        editor?.commands.setContent(`<p>${textToHtml(next)}</p>`);
        editor?.commands.focus("end");
      }
    } catch {
      setEnhanceError(t("aiassist.enhance.failed", { defaultValue: "AI 潤飾失敗,請重試" }));
    } finally {
      setEnhancing(false);
    }
  }

  // ---------------- 富卡片建構器(content_type="card" + meta.card) ----------------
  /** 開/關卡片建構器;開啟時關閉其他面板並清錯。 */
  function toggleCard() {
    setCardError(null);
    setShowCard((v) => !v);
    setShowEmoji(false);
    setShowKb(false);
    setShowCanned(false);
    setShowMacros(false);
    setShowEnhance(false);
  }
  /** 局部更新目前作用中的卡片(標題 / 內文 / 圖片)。 */
  function patchActiveCard(patch: Partial<Omit<CardDraft, "buttons">>) {
    setCards((cs) => cs.map((c, i) => (i === activeCard ? { ...c, ...patch } : c)));
  }
  /** 新增一張卡片並切換過去(達上限則忽略)。 */
  function addCard() {
    if (cards.length >= MAX_CARDS) return;
    setCards((cs) => [...cs, emptyCard()]);
    setActiveCard(cards.length); // 新卡索引 = 目前長度
    setCardError(null);
  }
  /** 移除指定卡片;僅剩一張時改為清空(維持至少一張),並校正作用中索引。 */
  function removeCard(idx: number) {
    if (cards.length <= 1) {
      setCards([emptyCard()]);
      setActiveCard(0);
      setCardError(null);
      return;
    }
    const next = cards.filter((_, i) => i !== idx);
    setCards(next);
    setActiveCard((a) => (a > idx ? a - 1 : Math.min(a, next.length - 1)));
    setCardError(null);
  }
  /** 以下按鈕操作皆作用於目前作用中的卡片。 */
  function addCardButton() {
    setCards((cs) =>
      cs.map((c, i) =>
        i === activeCard ? { ...c, buttons: [...c.buttons, { label: "", type: "url", value: "" }] } : c,
      ),
    );
  }
  function updateCardButton(i: number, patch: Partial<CardButtonDraft>) {
    setCards((cs) =>
      cs.map((c, ci) =>
        ci === activeCard
          ? { ...c, buttons: c.buttons.map((b, bi) => (bi === i ? { ...b, ...patch } : b)) }
          : c,
      ),
    );
  }
  function removeCardButton(i: number) {
    setCards((cs) =>
      cs.map((c, ci) =>
        ci === activeCard ? { ...c, buttons: c.buttons.filter((_, bi) => bi !== i) } : c,
      ),
    );
  }
  function resetCard() {
    setCards([emptyCard()]);
    setActiveCard(0);
    setCardError(null);
  }

  /** 送出卡片 / 輪播:逐張驗證 → ≥2 張存 meta.cards、1 張存 meta.card(向後相容)→
   *  走既有送訊端點(content_type="card"),content 存各卡標題彙整成的可讀回退文字
   *  (供歷史 / 舊客戶端降級)→ 樂觀插入本會話訊息快取。 */
  async function sendCard() {
    if (sendingCard) return;
    setCardError(null);
    if (!sessionId) {
      setCardError(t("workspace.rich.card.noSession", { defaultValue: "尚未開啟會話,無法送出卡片" }));
      return;
    }

    // 逐張驗證並組出送出契約;任何一張出錯即切換到該卡並提示。
    const built: SentCard[] = [];
    for (let ci = 0; ci < cards.length; ci++) {
      const c = cards[ci];
      const title = c.title.trim();
      const text = c.text.trim();
      const image = c.image.trim();
      if (image && !isHttpUrl(image)) {
        setActiveCard(ci);
        setCardError(t("workspace.rich.card.invalidImage", { defaultValue: "圖片 URL 需以 http(s):// 開頭" }));
        return;
      }
      // 逐一驗證按鈕:需 label,且 url 型需 http(s)、reply 型需文字
      const buttons: SentCardButton[] = [];
      for (const b of c.buttons) {
        const label = b.label.trim();
        const value = b.value.trim();
        if (!label) {
          setActiveCard(ci);
          setCardError(t("workspace.rich.card.needButtonLabel", { defaultValue: "每個按鈕都需要文字" }));
          return;
        }
        if (!value) {
          setActiveCard(ci);
          setCardError(t("workspace.rich.card.needButtonTarget", { defaultValue: "每個按鈕需填連結或快捷回覆文字" }));
          return;
        }
        if (b.type === "url") {
          if (!isHttpUrl(value)) {
            setActiveCard(ci);
            setCardError(t("workspace.rich.card.invalidButtonUrl", { defaultValue: "按鈕連結需以 http(s):// 開頭" }));
            return;
          }
          buttons.push({ label, url: value });
        } else if (b.type === "postback") {
          // postback:value 為機器 payload(訪客點擊後送出以觸發 bot 流程 / 自動化),不驗 URL。
          buttons.push({ label, postback: value });
        } else {
          buttons.push({ label, reply: value });
        }
      }
      // 每張卡片至少要有標題 / 內文 / 一個按鈕(空卡片不允許送出)
      if (!title && !text && buttons.length === 0) {
        setActiveCard(ci);
        setCardError(
          cards.length > 1
            ? t("workspace.rich.card.emptyCard", { defaultValue: "每張卡片需至少填寫標題、內文或一個按鈕" })
            : t("workspace.rich.card.empty", { defaultValue: "請至少填寫標題、內文或一個按鈕" }),
        );
        return;
      }
      built.push({
        title: title || undefined,
        text: text || undefined,
        image_url: image || undefined,
        buttons,
      });
    }
    if (built.length === 0) {
      setCardError(t("workspace.rich.card.empty", { defaultValue: "請至少填寫標題、內文或一個按鈕" }));
      return;
    }

    // 可讀回退:各卡以「標題→內文→按鈕文字」擇一取其代表字,再彙整;皆無則通用字樣。
    const fallback =
      built
        .map((c) => c.title || c.text || c.buttons.map((b) => b.label).join(" / "))
        .filter(Boolean)
        .join(" / ") || t("workspace.rich.card.fallback", { defaultValue: "[卡片訊息]" });

    // ≥2 張 → meta.cards(輪播);1 張 → meta.card(向後相容,現狀單卡)。
    const multi = built.length >= 2;
    const meta = multi ? { cards: built } : { card: built[0] };

    setSendingCard(true);
    try {
      const raw = await apiFetch<RawMessage>(
        `/api/v1/conversation/sessions/${sessionId}/messages`,
        { method: "POST", body: { content: fallback, content_type: "card", meta } },
      );
      const msg = mapMessage(raw);
      // 樂觀補強:adapters.mapMessage 目前僅映射 meta.card→message.card(未映射 meta.cards),
      // 故多卡時就地補上 cards 欄位,讓剛送出的輪播即時呈現(單卡則 adapters 已映射)。
      // 註:歷史重整 / WS-only 收訊要保住多卡,需主 session 於 adapters 一併映射 cards(見回報)。
      const enriched = (multi ? { ...msg, cards: built } : { ...msg, card: built[0] }) as unknown as Message;
      // 樂觀插入(以 id 去重,避免與 WS message.new 推送重複),與附件送訊一致
      qc.setQueryData<Message[]>(qk.messages(sessionId), (old) => {
        if (!old) return old;
        if (old.some((m) => m.id === enriched.id)) return old;
        return [...old, enriched];
      });
      qc.invalidateQueries({ queryKey: ["sessions"] });
      resetCard();
      setShowCard(false);
    } catch {
      setCardError(t("workspace.rich.card.sendFailed", { defaultValue: "卡片送出失敗,請重試" }));
    } finally {
      setSendingCard(false);
    }
  }

  // 附件:開檔案選擇 → 上傳 → 建立坐席附件訊息(後端)→ 即時插入本會話訊息快取
  function pickAttachment() {
    setToolError(null);
    if (!sessionId) {
      setToolError(t("composer.uploadNoSession", "尚未開啟會話,無法上傳附件"));
      return;
    }
    fileInputRef.current?.click();
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // 清空 value,讓連續選同一檔也會觸發 change
    e.target.value = "";
    if (!file) return;
    if (!sessionId) {
      setToolError(t("composer.uploadNoSession", "尚未開啟會話,無法上傳附件"));
      return;
    }
    setToolError(null);
    setUploading(true);
    try {
      const msg = await attachmentsApi.upload(sessionId, file);
      // 樂觀插入(以 id 去重,避免與 WS message.new 推送重複),與坐席文字送訊一致
      qc.setQueryData<Message[]>(qk.messages(sessionId), (old) => {
        if (!old) return old;
        if (old.some((m) => m.id === msg.id)) return old;
        return [...old, msg];
      });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    } catch {
      setToolError(t("composer.uploadFailed", "附件上傳失敗,請重試"));
    } finally {
      setUploading(false);
    }
  }

  const canNote = !!onSendNote;
  // 目前作用中的卡片草稿(卡片建構器多卡切換用);索引已於增刪時校正,理論上恆有效,仍容錯回退首卡。
  const activeCardDraft = cards[activeCard] ?? cards[0];

  // 已結束會話:不渲染輸入框與工具列,改以提示條 + 「重新開啟」入口取代,
  // 從源頭杜絕「送訊靜默重開」(送訊會 auto-claim 使 status=open)。
  if (disabled) {
    return (
      <div className="border-t border-border bg-card p-2.5">
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            {disabledHint ?? t("composer.closedHint", { defaultValue: "此會話已結束" })}
          </span>
          {onReopen && (
            <Button size="sm" variant="default" className="shrink-0 gap-1" onClick={onReopen}>
              <RotateCcw className="h-3.5 w-3.5" />
              {t("conv.reopen", { defaultValue: "重新開啟" })}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative border-t p-2.5 transition-colors",
        noteMode ? "border-warning/40 bg-warning/5" : "border-border bg-card",
      )}
    >
      {/* 快捷語彈出(真 API) */}
      {showCanned && canned.length > 0 && (
        <div className="absolute bottom-full left-2.5 mb-1 w-80 overflow-hidden rounded-md border border-border bg-popover shadow-md">
          <div className="border-b border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <Zap className="mr-1 inline h-3 w-3" /> {t("workspace.composer.cannedHint")}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {canned.map((c) => (
              <button
                key={c.id}
                onClick={() => insertCanned(c)}
                className="flex w-full flex-col items-start px-2.5 py-1.5 text-left hover:bg-accent"
              >
                <span className="flex w-full items-center gap-1.5">
                  <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                    /{c.shortcut}
                  </span>
                  <span className="truncate text-xs font-medium">{c.title}</span>
                  {c.shared && (
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{t("workspace.composer.shared")}</span>
                  )}
                </span>
                <span className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{c.content}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Emoji 選擇器(自建輕量面板) */}
      {showEmoji && (
        <div className="absolute bottom-full left-2.5 mb-1 w-72 overflow-hidden rounded-md border border-border bg-popover shadow-md">
          <div className="border-b border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <Smile className="mr-1 inline h-3 w-3" /> {t("composer.emojiTitle", "常用表情")}
          </div>
          <div className="grid grid-cols-8 gap-0.5 p-1.5">
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => insertEmoji(emoji)}
                className="flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-accent"
                aria-label={emoji}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 插入知識庫:小搜尋框查知識庫,選一則插入輸入框 */}
      {showKb && (
        <div className="absolute bottom-full left-2.5 mb-1 w-80 overflow-hidden rounded-md border border-border bg-popover shadow-md">
          <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              autoFocus
              value={kbQuery}
              onChange={(e) => setKbQuery(e.target.value)}
              placeholder={t("composer.kbSearchPlaceholder", "搜尋知識庫…")}
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            {kbLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {kbHits.length > 0 ? (
              kbHits.map((hit, i) => (
                <button
                  key={hit.source_ref?.title ?? hit.source_ref?.question ?? `kb-${i}`}
                  type="button"
                  onClick={() => insertKbHit(hit)}
                  className="flex w-full flex-col items-start px-2.5 py-1.5 text-left hover:bg-accent"
                >
                  <span className="truncate text-xs font-medium">
                    {hit.source_ref?.title ?? hit.source_ref?.question ?? t("composer.kbFallbackTitle", "知識片段")}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{hit.content}</span>
                </button>
              ))
            ) : (
              <div className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
                {kbLoading
                  ? t("composer.kbSearching", "搜尋中…")
                  : kbQuery.trim()
                    ? t("composer.kbEmpty", "查無相關知識")
                    : t("composer.kbHint", "點選一則插入輸入框")}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 巨集面板:列出啟用中的巨集,點選套用 */}
      {showMacros && (
        <div className="absolute bottom-full left-2.5 mb-1 w-80 overflow-hidden rounded-md border border-border bg-popover shadow-md">
          <div className="border-b border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <Wand2 className="mr-1 inline h-3 w-3" /> {t("macros.pickHint", { defaultValue: "點選巨集以套用其動作" })}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {macros.length > 0 ? (
              macros.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  disabled={applyingMacro}
                  onClick={() => applyMacro(m)}
                  className="flex w-full flex-col items-start px-2.5 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                >
                  <span className="truncate text-xs font-medium">{m.name}</span>
                  {m.description && (
                    <span className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{m.description}</span>
                  )}
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {(m.actions ?? []).map((a, i) => (
                      <span key={i} className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        {t(`macros.action.${a.type}`, { defaultValue: a.type })}
                      </span>
                    ))}
                  </span>
                </button>
              ))
            ) : (
              <div className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
                {t("macros.empty", { defaultValue: "尚無可用巨集" })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* AI 潤飾:下拉選改寫動作 */}
      {showEnhance && (
        <div className="absolute bottom-full left-2.5 mb-1 w-56 overflow-hidden rounded-md border border-border bg-popover shadow-md">
          <div className="border-b border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <Sparkles className="mr-1 inline h-3 w-3" /> {t("aiassist.enhance.title", { defaultValue: "AI 潤飾" })}
          </div>
          <div className="py-1">
            {ENHANCE_ACTIONS.map((a) => (
              <button
                key={a.key}
                type="button"
                disabled={enhancing}
                onClick={() => runEnhance(a.key)}
                className="flex w-full items-center px-2.5 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50"
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 富卡片建構器:支援輪播(多張卡片),每卡各自標題 / 文字 / 圖 + 按鈕(url 開連結 / reply 快捷回覆) */}
      {showCard && (
        <div className="absolute bottom-full left-2.5 mb-1 w-96 max-w-[calc(100vw-24px)] overflow-hidden rounded-md border border-border bg-popover shadow-md">
          <div className="border-b border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <LayoutTemplate className="mr-1 inline h-3 w-3" /> {t("workspace.rich.card.title", { defaultValue: "插入卡片 / 按鈕" })}
          </div>

          {/* 卡片頁籤列:切換 / 新增 / 移除卡片(≥2 張送出時以輪播呈現) */}
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-2.5 py-1.5">
            {cards.map((_, i) => (
              <span
                key={i}
                className={cn(
                  "flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]",
                  i === activeCard
                    ? "border-brand bg-brand/10 font-medium text-brand"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                <button type="button" onClick={() => setActiveCard(i)} className="outline-none">
                  {t("workspace.rich.card.cardLabel", { n: i + 1, defaultValue: "卡片 {{n}}" })}
                </button>
                {cards.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeCard(i)}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t("workspace.rich.card.removeCard", { defaultValue: "移除此卡片" })}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2"
              onClick={addCard}
              disabled={cards.length >= MAX_CARDS}
              title={
                cards.length >= MAX_CARDS
                  ? t("workspace.rich.card.maxCardsHint", { max: MAX_CARDS, defaultValue: "最多 {{max}} 張卡片" })
                  : undefined
              }
            >
              <Plus className="h-3.5 w-3.5" /> {t("workspace.rich.card.addCard", { defaultValue: "新增卡片" })}
            </Button>
          </div>

          <div className="max-h-80 space-y-2.5 overflow-y-auto p-2.5">
            {cards.length > 1 && (
              <div className="text-[11px] text-muted-foreground">
                {t("workspace.rich.card.carouselHint", {
                  count: cards.length,
                  defaultValue: "共 {{count}} 張,送出後以輪播(carousel)橫向呈現",
                })}
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                {t("workspace.rich.card.cardTitle", { defaultValue: "標題" })}
              </label>
              <input
                value={activeCardDraft.title}
                onChange={(e) => patchActiveCard({ title: e.target.value })}
                placeholder={t("workspace.rich.card.cardTitlePlaceholder", { defaultValue: "卡片標題(選填)" })}
                className="w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                {t("workspace.rich.card.cardText", { defaultValue: "內文" })}
              </label>
              <textarea
                value={activeCardDraft.text}
                onChange={(e) => patchActiveCard({ text: e.target.value })}
                placeholder={t("workspace.rich.card.cardTextPlaceholder", { defaultValue: "卡片文字(選填)" })}
                className="min-h-[52px] w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                {t("workspace.rich.card.imageUrl", { defaultValue: "圖片 URL(選填)" })}
              </label>
              <input
                value={activeCardDraft.image}
                onChange={(e) => patchActiveCard({ image: e.target.value })}
                placeholder="https://…/image.png"
                className="w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-[11px] outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* 按鈕清單(作用於目前卡片) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t("workspace.rich.card.buttons", { defaultValue: "按鈕" })}
                </span>
                <Button variant="outline" size="sm" className="h-7" onClick={addCardButton}>
                  <Plus className="h-3.5 w-3.5" /> {t("workspace.rich.card.addButton", { defaultValue: "新增按鈕" })}
                </Button>
              </div>
              {activeCardDraft.buttons.map((b, i) => (
                <div key={i} className="space-y-1.5 rounded-md border border-border p-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      value={b.label}
                      onChange={(e) => updateCardButton(i, { label: e.target.value })}
                      placeholder={t("workspace.rich.card.buttonLabel", { defaultValue: "按鈕文字" })}
                      className="h-7 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    />
                    <select
                      value={b.type}
                      onChange={(e) => updateCardButton(i, { type: e.target.value as CardButtonDraft["type"] })}
                      className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="url">{t("workspace.rich.card.typeUrl", { defaultValue: "連結" })}</option>
                      <option value="reply">{t("workspace.rich.card.typeReply", { defaultValue: "快捷回覆" })}</option>
                      <option value="postback">{t("workspace.rich.card.typePostback", { defaultValue: "Postback" })}</option>
                    </select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeCardButton(i)}
                      className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
                      aria-label={t("workspace.rich.card.removeButton", { defaultValue: "移除按鈕" })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {b.type === "url" ? (
                      <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : b.type === "postback" ? (
                      <Zap className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <input
                      value={b.value}
                      onChange={(e) => updateCardButton(i, { value: e.target.value })}
                      placeholder={
                        b.type === "url"
                          ? "https://…"
                          : b.type === "postback"
                            ? t("workspace.rich.card.postbackPlaceholder", { defaultValue: "點擊後送出的 payload(觸發 bot 流程)" })
                            : t("workspace.rich.card.replyPlaceholder", { defaultValue: "點擊後以訪客身分送出的文字" })
                      }
                      className="h-7 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
              ))}
            </div>

            {cardError && <div className="text-[11px] font-medium text-destructive">{cardError}</div>}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-2.5 py-1.5">
            <Button variant="ghost" size="sm" onClick={() => setShowCard(false)} disabled={sendingCard}>
              {t("workspace.rich.card.cancel", { defaultValue: "取消" })}
            </Button>
            <Button size="sm" onClick={sendCard} disabled={sendingCard || !sessionId}>
              {sendingCard ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {t("workspace.rich.card.send", { defaultValue: "送出卡片" })}
            </Button>
          </div>
        </div>
      )}

      {/* AI 潤飾處理中 / 失敗提示 */}
      {enhancing && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("aiassist.enhance.processing", { defaultValue: "AI 潤飾中…" })}
        </div>
      )}
      {enhanceError && (
        <div className="mb-1.5 text-[11px] font-medium text-destructive">{enhanceError}</div>
      )}

      {/* 巨集套用結果提示 */}
      {macroMsg && (
        <div className="mb-1.5 flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{macroMsg}</span>
          <button type="button" onClick={() => setMacroMsg(null)} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={t("macros.close", { defaultValue: "關閉" })}>
            ×
          </button>
        </div>
      )}

      {/* 內部備註模式提示條 */}
      {noteMode && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-warning">
          <StickyNote className="h-3.5 w-3.5" />
          {t("workspace.composer.noteModeHint")}
        </div>
      )}

      {/* 附件上傳中 / 錯誤提示 */}
      {uploading && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("composer.uploading", "附件上傳中…")}
        </div>
      )}
      {toolError && (
        <div className="mb-1.5 text-[11px] font-medium text-destructive">{toolError}</div>
      )}

      <div
        className={cn(
          "rounded-md border focus-within:ring-2 focus-within:ring-ring",
          noteMode ? "border-warning/50 bg-warning/10" : "border-input",
        )}
      >
        <EditorContent editor={editor} />
        <div className="flex items-center gap-0.5 border-t border-border px-1.5 py-1">
          {/* 對客 / 內部備註 切換 */}
          {canNote && (
            <SimpleTooltip label={noteMode ? t("workspace.composer.switchToCustomer") : t("workspace.composer.switchToNote")} side="top">
              <Button
                variant={noteMode ? "default" : "ghost"}
                size="icon-sm"
                aria-pressed={noteMode}
                aria-label={t("workspace.composer.noteModeLabel")}
                onClick={() => setNoteMode((v) => !v)}
                className={cn(noteMode && "bg-warning text-warning-foreground hover:bg-warning/90")}
              >
                {noteMode ? <MessageSquare className="h-4 w-4" /> : <StickyNote className="h-4 w-4" />}
              </Button>
            </SimpleTooltip>
          )}
          {/* 隱藏檔案輸入:附件鈕觸發;accept 對齊後端 storage 白名單 */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.pdf,.txt,.csv,.md,.rtf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.rar,.7z"
            onChange={onFileChange}
          />
          <SimpleTooltip label={t("workspace.composer.attachment")} side="top">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={pickAttachment}
              disabled={uploading}
              aria-label={t("workspace.composer.attachment")}
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
            </Button>
          </SimpleTooltip>
          <SimpleTooltip label={t("workspace.composer.emoji")} side="top">
            <Button
              variant={showEmoji ? "default" : "ghost"}
              size="icon-sm"
              aria-pressed={showEmoji}
              aria-label={t("workspace.composer.emoji")}
              onClick={toggleEmoji}
            >
              <Smile className="h-4 w-4" />
            </Button>
          </SimpleTooltip>
          <SimpleTooltip label={t("workspace.composer.insertKb")} side="top">
            <Button
              variant={showKb ? "default" : "ghost"}
              size="icon-sm"
              aria-pressed={showKb}
              aria-label={t("workspace.composer.insertKb")}
              onClick={toggleKb}
            >
              <BookOpen className="h-4 w-4" />
            </Button>
          </SimpleTooltip>
          <SimpleTooltip label={t("workspace.composer.cannedShortcut")} side="top">
            <Button variant="ghost" size="icon-sm" onClick={() => setShowCanned((v) => !v)}>
              <Zap className="h-4 w-4" />
            </Button>
          </SimpleTooltip>
          {/* 富訊息:插入卡片 / 按鈕(標題/文字/圖 + url 連結或 quick-reply) */}
          <SimpleTooltip label={t("workspace.rich.card.button", { defaultValue: "插入卡片 / 按鈕" })} side="top">
            <Button
              variant={showCard ? "default" : "ghost"}
              size="icon-sm"
              aria-pressed={showCard}
              aria-label={t("workspace.rich.card.button", { defaultValue: "插入卡片 / 按鈕" })}
              onClick={toggleCard}
            >
              <LayoutTemplate className="h-4 w-4" />
            </Button>
          </SimpleTooltip>
          <SimpleTooltip label={t("macros.button", { defaultValue: "巨集" })} side="top">
            <Button
              variant={showMacros ? "default" : "ghost"}
              size="icon-sm"
              aria-pressed={showMacros}
              aria-label={t("macros.button", { defaultValue: "巨集" })}
              onClick={toggleMacros}
            >
              <Wand2 className="h-4 w-4" />
            </Button>
          </SimpleTooltip>
          {/* AI 潤飾:對輸入框內容改寫(擴寫/改寫/精簡/正式/親切/修錯);空時禁用 */}
          <SimpleTooltip label={t("aiassist.enhance.button", { defaultValue: "AI 潤飾" })} side="top">
            <Button
              variant={showEnhance ? "default" : "ghost"}
              size="icon-sm"
              aria-pressed={showEnhance}
              aria-label={t("aiassist.enhance.button", { defaultValue: "AI 潤飾" })}
              onClick={toggleEnhance}
              disabled={!text.trim() || enhancing}
            >
              {enhancing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            </Button>
          </SimpleTooltip>
          {/* 附加簽名開關:僅對客回覆生效;簽名於「設定 → 個人資料」設定 */}
          <SimpleTooltip
            label={
              appendSig
                ? signature.trim()
                  ? t("composer.appendSignatureOn", { defaultValue: "送出時將附加你的簽名檔" })
                  : t("composer.signatureEmptyHint", { defaultValue: "尚未設定簽名檔,請至「設定 → 個人資料」填寫" })
                : t("composer.appendSignatureOff", { defaultValue: "送出時不附加簽名檔" })
            }
            side="top"
          >
            <Button
              variant={appendSig ? "default" : "ghost"}
              size="icon-sm"
              aria-pressed={appendSig}
              aria-label={t("composer.appendSignature", { defaultValue: "附加簽名" })}
              onClick={toggleAppendSig}
              disabled={noteMode}
            >
              <PenLine className="h-4 w-4" />
            </Button>
          </SimpleTooltip>
          <div className="flex-1" />
          <span className="mr-2 text-[10px] text-muted-foreground">{t("workspace.composer.sendHint")}</span>
          <Button
            size="sm"
            onClick={send}
            className={cn(
              !text.trim() && "opacity-60",
              noteMode && "bg-warning text-warning-foreground hover:bg-warning/90",
            )}
          >
            {noteMode ? <StickyNote className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
            {noteMode ? t("workspace.composer.saveNote") : t("workspace.send")}
          </Button>
        </div>
      </div>
    </div>
  );
}
