/** Stripe Checkout 端點封裝(計費整合首版,測試模式)。
 *  呼叫後端 /billing/checkout 建立 Stripe 託管結帳工作階段,回 hosted url;
 *  前端只負責 window.location 導向,絕不碰卡號。
 *  後端未設定金鑰時會回 BILLING_STRIPE_DISABLED(由 client 轉為 ApiError.code),
 *  呼叫端據此顯示「測試模式:請管理員設定 Stripe 金鑰」。 */
import { call } from "./client";

export interface CheckoutResult {
  url: string | null;
  session_id: string | null;
  plan_id: string;
}

export const checkoutApi = {
  /** 建立訂閱型 Checkout Session(admin;body {plan_id, success_url, cancel_url})。 */
  create: (plan_id: string, success_url: string, cancel_url: string) =>
    call<CheckoutResult>({
      path: "/api/v1/billing/checkout",
      method: "POST",
      body: { plan_id, success_url, cancel_url },
      real: true,
    }),
};
