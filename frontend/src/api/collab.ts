/** 團隊協作 API(W6 自建):旁支會話 / 旁支訊息 / 協作者 / @提及。
 *  對齊後端 /api/v1/collab(見 backend/app/api/v1/collab.py),沿用 ./client 的
 *  call()(自動解 {ok,data,error} 信封)。型別就地定義(不動共用 types/index.ts)。
 *
 *  @提及解析/儲存(首版):
 *  - 可提及坐席清單來自 mentionable();前端在輸入框以 `@` 觸發下拉。
 *  - 選取後把 `@顯示名 ` 併入純文字內容,並在本地記下該坐席 id。
 *  - 送出旁支訊息 → sendSideMessage(content, mentions):後端驗證 id 屬本租戶後回傳解析結果;
 *    SideMessage 無 meta 欄,@提及僅以文字存於 content。
 *  - 送出私密備註 → addNoteWithMentions(content, mentions):走既有 conversation notes 端點,
 *    把 mentions 記入 meta.mentions(供未來通知),content 仍含純文字 @名字。 */
import { call } from "./client";
import { mapMessage, type RawMessage } from "./adapters";
import type { Message } from "@/types";

/* ================================ 型別 ================================ */

export type SideKind = "internal" | "external";
export type SideStatus = "open" | "closed";
export type ParticipantRole = "collaborator" | "watcher";

/** 旁支會話(在主會話旁另開的對內 / 對第三方討論串)。 */
export interface SideConversation {
  id: string;
  session_id: string;
  topic: string | null;
  kind: SideKind;
  status: SideStatus;
  created_by: string | null;
  created_at: string | null;
}

/** 單一 @提及參照(坐席 id + 顯示名)。 */
export interface MentionRef {
  staff_id: string;
  display_name: string;
}

/** 旁支討論串內的一則訊息。 */
export interface SideMessage {
  id: string;
  side_conversation_id: string;
  sender_staff_id: string | null;
  content: string;
  created_at: string | null;
  /** 本則解析出的 @提及(後端回傳;未落庫,僅供呈現) */
  mentions: MentionRef[];
}

/** 主會話協作者 / 關注者。 */
export interface Participant {
  id: string;
  session_id: string;
  staff_id: string;
  role: ParticipantRole;
  created_at: string | null;
  display_name: string | null;
  email: string | null;
}

/** 可被 @提及 的坐席。 */
export interface MentionableStaff {
  id: string;
  display_name: string;
  email: string | null;
  status?: string;
}

/* ================================ API ================================ */

export const collabApi = {
  /* ------------------------------ 旁支會話 ------------------------------ */

  /** 列某主會話的旁支討論串(可依 status 過濾)。攤平 {items} → 陣列。 */
  listSide: (sessionId: string, status?: SideStatus) =>
    call<{ items: SideConversation[] }>({
      path: `/api/v1/collab/sessions/${sessionId}/side`,
      params: { status },
      real: true,
      mock: async () => ({ items: [] }),
    }).then((r) => r.items ?? []),

  /** 建立一條旁支討論串(topic 選填;kind 預設 internal)。 */
  createSide: (sessionId: string, body: { topic?: string; kind: SideKind }) =>
    call<SideConversation>({
      path: `/api/v1/collab/sessions/${sessionId}/side`,
      method: "POST",
      body,
      real: true,
    }),

  /** 關閉一條旁支討論串。 */
  closeSide: (sideId: string) =>
    call<SideConversation>({
      path: `/api/v1/collab/side/${sideId}/close`,
      method: "POST",
      real: true,
    }),

  /* ------------------------------ 旁支訊息 ------------------------------ */

  /** 列旁支討論串訊息(舊→新)。攤平 {items} → 陣列。 */
  listSideMessages: (sideId: string, limit = 100) =>
    call<{ items: SideMessage[] }>({
      path: `/api/v1/collab/side/${sideId}/messages`,
      params: { limit },
      real: true,
      mock: async () => ({ items: [] }),
    }).then((r) => r.items ?? []),

  /** 在旁支討論串發訊;mentions 為 @提及坐席 id 陣列(選填)。 */
  sendSideMessage: (sideId: string, content: string, mentions?: string[]) =>
    call<SideMessage>({
      path: `/api/v1/collab/side/${sideId}/messages`,
      method: "POST",
      body: { content, mentions: mentions?.length ? mentions : undefined },
      real: true,
    }),

  /* ---------------------------- 協作者 / 關注者 ---------------------------- */

  /** 列主會話協作者 / 關注者。攤平 {items} → 陣列。 */
  listParticipants: (sessionId: string) =>
    call<{ items: Participant[] }>({
      path: `/api/v1/collab/sessions/${sessionId}/participants`,
      real: true,
      mock: async () => ({ items: [] }),
    }).then((r) => r.items ?? []),

  /** 加入 / 更新協作者角色(冪等)。 */
  addParticipant: (sessionId: string, staff_id: string, role: ParticipantRole = "collaborator") =>
    call<Participant>({
      path: `/api/v1/collab/sessions/${sessionId}/participants`,
      method: "POST",
      body: { staff_id, role },
      real: true,
    }),

  /** 移除協作者 / 關注者(冪等)。 */
  removeParticipant: (sessionId: string, staffId: string) =>
    call<{ session_id: string; staff_id: string; removed: boolean }>({
      path: `/api/v1/collab/sessions/${sessionId}/participants/${staffId}`,
      method: "DELETE",
      real: true,
    }),

  /* -------------------------------- @提及 -------------------------------- */

  /** 可提及坐席清單(本租戶、啟用中;q 模糊比對)。攤平 {items} → 陣列。 */
  mentionable: (q?: string) =>
    call<{ items: MentionableStaff[] }>({
      path: "/api/v1/collab/staff/mentionable",
      params: { q },
      real: true,
      mock: async () => ({ items: [] }),
    }).then((r) => r.items ?? []),

  /** 送出帶 @提及的私密內部備註:走既有 conversation notes 端點,mentions 記入 meta。
   *  content 已含純文字 @名字;回傳映射後 Message,供插入本會話訊息快取。 */
  addNoteWithMentions: (sessionId: string, content: string, mentions: MentionRef[]) =>
    call<Message>({
      path: `/api/v1/conversation/sessions/${sessionId}/notes`,
      method: "POST",
      body: { content, meta: mentions.length ? { mentions } : undefined },
      real: true,
    }).then((raw) => mapMessage(raw as unknown as RawMessage)),
};
