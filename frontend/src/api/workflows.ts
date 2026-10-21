/**
 * AI 工作流編排前端型別化封裝(W6 首版)。
 *
 * 對接後端 /api/v1/workflows(CRUD + catalog + 手動觸發執行測試)。
 * 一律走 client.ts 的 call() 統一入口(real:true → auto 模式打真 API)。
 */
import { call } from "@/api/client";

/** 節點下一步:線性為節點 id 字串;condition 為 {true,false} 分支對照。 */
export type NodeNext = string | { true?: string; false?: string; default?: string };

/** 單一節點定義。config 依型別而異(見 catalog)。 */
export interface NodeDef {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  next?: NodeNext;
}

/** 流程定義:起始節點 + 節點清單。 */
export interface WorkflowDefinition {
  start?: string;
  nodes: NodeDef[];
}

/** 後端工作流資料形狀。 */
export interface WorkflowDto {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  definition: WorkflowDefinition;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkflowListResp {
  items: WorkflowDto[];
  total: number;
  limit: number;
  offset: number;
}

/** catalog:節點型別與其 config 欄位提示。 */
export interface CatalogConfigField {
  name: string;
  type: string;
  required?: boolean;
  options?: string[];
}
export interface CatalogNodeType {
  type: string;
  label: string;
  config: CatalogConfigField[];
  branching: boolean;
}
export interface WorkflowCatalog {
  node_types: CatalogNodeType[];
  condition_ops: { op: string; label: string }[];
  triggers: { trigger: string; label: string }[];
}

/** 執行軌跡單條。 */
export interface TraceEntry {
  node_id: string | null;
  type: string | null;
  status: string; // ok | skip | error | end
  info: Record<string, unknown>;
}

/** 執行結果。 */
export interface RunResult {
  status: string; // completed | stopped | error | empty
  steps: number;
  dry_run: boolean;
  trace: TraceEntry[];
  reason: string | null;
  ctx: Record<string, unknown>;
}

export interface RunResp {
  workflow_id: string;
  result: RunResult;
}

/** 建立 / 更新請求體(欄位皆選填於 update)。 */
export interface WorkflowInput {
  name?: string;
  description?: string | null;
  trigger?: string;
  definition?: WorkflowDefinition | null;
  is_active?: boolean;
}

const BASE = "/api/v1/workflows";

export const workflowsApi = {
  /** 節點型別 / 運算子 / 觸發時機目錄。 */
  catalog: () => call<WorkflowCatalog>({ path: `${BASE}/catalog`, real: true }),

  /** 列出本租戶工作流。 */
  list: (isActive?: boolean) =>
    call<WorkflowListResp>({
      path: BASE,
      params: isActive === undefined ? undefined : { is_active: isActive },
      real: true,
    }),

  /** 取單筆。 */
  get: (id: string) => call<WorkflowDto>({ path: `${BASE}/${id}`, real: true }),

  /** 建立(需 workflow.manage)。 */
  create: (body: WorkflowInput) =>
    call<WorkflowDto>({ path: BASE, method: "POST", body, real: true }),

  /** 更新(需 workflow.manage)。 */
  update: (id: string, body: WorkflowInput) =>
    call<WorkflowDto>({ path: `${BASE}/${id}`, method: "PATCH", body, real: true }),

  /** 軟刪(需 workflow.manage)。 */
  remove: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `${BASE}/${id}`,
      method: "DELETE",
      real: true,
    }),

  /** 手動觸發執行(測試),回軌跡與結果(需 workflow.manage)。 */
  run: (id: string, body: { ctx?: Record<string, unknown>; dry_run?: boolean }) =>
    call<RunResp>({ path: `${BASE}/${id}/run`, method: "POST", body, real: true }),
};
