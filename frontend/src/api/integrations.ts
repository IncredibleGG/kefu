/** 第一方整合 / 插件 API:對齊後端 /api/v1/integrations。
 *  沿用 ./client 的 call()(自動解 {ok,data,error} 信封 / Bearer / mock)。
 *  型別就地定義(不動共用 types/index.ts)。 */
import { call } from "@/api/client";

/** config_schema 單一欄位(對齊後端目錄常數的欄位形狀)。 */
export interface IntegrationField {
  key: string;
  label: string;
  type: "text" | "password" | "textarea";
  required?: boolean;
  /** 機敏欄位:回傳遮罩、送回遮罩值 / 留空表示不變更。 */
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

/** 目錄項 + 本租戶啟用狀態(GET /catalog 的元素)。 */
export interface IntegrationItem {
  key: string;
  name: string;
  description: string;
  category: string;
  requires_config: boolean;
  config_schema: IntegrationField[];
  enabled: boolean;
  /** 機敏欄位已遮罩(如 "abcd…wxyz");非機敏欄位為原值。 */
  config: Record<string, unknown>;
  /** 是否已備妥必填設定。 */
  configured: boolean;
  updated_at: string | null;
}

export interface IntegrationCatalog {
  integrations: IntegrationItem[];
}

/** PUT 內容:開關與 / 或設定;皆選填。 */
export interface IntegrationUpdateInput {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface IntegrationStatus {
  key: string;
  enabled: boolean;
  requires_config: boolean;
  configured: boolean;
}

export const integrationsApi = {
  /** 整合目錄 + 本租戶各 key 的 enabled / config(機敏遮罩)。 */
  catalog: () =>
    call<IntegrationCatalog>({
      path: "/api/v1/integrations/catalog",
      real: true,
      mock: async () => ({ integrations: [] }),
    }),

  /** 設定某整合的開關與設定(upsert)。 */
  update: (key: string, body: IntegrationUpdateInput) =>
    call<IntegrationItem>({
      path: `/api/v1/integrations/${key}`,
      method: "PUT",
      body,
      real: true,
    }),

  /** 單一整合的輕量狀態。 */
  status: (key: string) =>
    call<IntegrationStatus>({
      path: `/api/v1/integrations/${key}/status`,
      real: true,
    }),
};
