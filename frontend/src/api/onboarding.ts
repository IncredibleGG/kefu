/** 新手 onboarding 首次使用清單 API。
 *  對齊後端 /api/v1/onboarding(見 backend/app/api/v1/onboarding.py),沿用 ./client 的 call()
 *  (自動解 {ok,data,error} 信封、帶 Bearer)。型別就地定義,不動共用 types/index.ts。
 */
import { call } from "./client";

/** 單一 onboarding 步驟完成狀態。key 為穩定識別碼(channel/widget/knowledge/ai/staff/channel_live),
 *  文案與「前往」連結由前端依 key 對應。 */
export interface OnboardingStep {
  key: string;
  done: boolean;
}

/** onboarding 完成度總覽。done_count === total 代表全部完成。 */
export interface OnboardingStatus {
  steps: OnboardingStep[];
  done_count: number;
  total: number;
}

/** react-query queryKey。 */
export const onboardingKeys = {
  status: ["onboarding", "status"] as const,
};

export const onboardingApi = {
  /** 取租戶 onboarding 各步驟完成度(租戶隔離)。 */
  status: () =>
    call<OnboardingStatus>({
      path: "/api/v1/onboarding/status",
      real: true,
      // 無後端 demo 時的回退:全未完成,讓卡片可見以呈現引導。
      mock: async () => ({
        steps: [
          { key: "channel", done: false },
          { key: "widget", done: false },
          { key: "knowledge", done: false },
          { key: "ai", done: false },
          { key: "staff", done: false },
          { key: "channel_live", done: false },
        ],
        done_count: 0,
        total: 6,
      }),
    }),
};
