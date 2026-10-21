/** 坐席附件上傳 API(自建,走 ./client 的 apiFetch;對齊後端 {ok,data,error} 信封)。
 *
 *  upload:把檔案以 multipart 傳到坐席附件端點,後端存檔並建立一則坐席附件訊息,
 *  回傳映射後的 Message(content 為本站取檔 URL、content_type=image|file),
 *  供輸入區在送出後即時插入該會話訊息快取。 */
import { apiFetch } from "./client";
import { mapMessage, type RawMessage } from "./adapters";
import type { Message } from "@/types";

export const attachmentsApi = {
  /** 上傳附件到指定會話(sessionId);回映射後的坐席附件 Message。
   *  FormData 交給瀏覽器自帶 multipart boundary(apiFetch 已自動不設 Content-Type)。 */
  upload: (sessionId: string, file: File): Promise<Message> => {
    const form = new FormData();
    form.append("file", file);
    return apiFetch<RawMessage>(
      `/api/v1/attachments/sessions/${sessionId}/upload`,
      { method: "POST", body: form },
    ).then((m) => mapMessage(m));
  },
};
