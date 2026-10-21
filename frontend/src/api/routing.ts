/**
 * M8 routing 前端型別化封裝。
 *
 * endpoints.ts 的 `routingApi` 已提供 queue / loads / auto-assign / assign-to /
 * claim / list-policies,但回傳型別為 `unknown`,且未涵蓋「設定分派策略」
 * (後端 PUT /policies)。本檔在不改動 endpoints.ts 的前提下:
 *   1. 為既有 routingApi 方法補上具名回應型別(薄封裝,只加型別不改行為);
 *   2. 補上 upsertPolicy(PUT /policies)——routingApi 未匯出。
 */
import { call } from "@/api/client";
import { routingApi } from "@/api/endpoints";

/** 後端支援的分派策略(對齊 backend VALID_STRATEGIES)。 */
export type RoutingStrategy = "least_load" | "round_robin" | "llm";
export const ROUTING_STRATEGIES: RoutingStrategy[] = ["least_load", "round_robin", "llm"];

/** 佇列中的單一會話(未分配)。 */
export interface QueueItem {
  session_id: string;
  skill_group_id: string | null;
  channel_id: string;
  created_at: string | null;
}

/** GET /queue 回應。 */
export interface QueueResp {
  count: number;
  sessions: QueueItem[];
}

/** 候選在線坐席的即時負載快照。 */
export interface RoutingAgentLoad {
  staff_id: string;
  current_load: number;
  max_load: number;
  available: boolean;
}

/** 一條分派策略(某技能組;skill_group_id 為 null = 租戶預設)。 */
export interface RoutingPolicyDto {
  id: string;
  skill_group_id: string | null;
  strategy: string;
  max_load: number;
  is_active: boolean;
}

/** POST /sessions/{id}/assign(自動指派)回應。 */
export interface AutoAssignResult {
  session_id: string;
  assigned_staff_id: string | null;
  queued: boolean;
}

/** 手動指派 / 認領回應。 */
export interface AssignResult {
  session_id: string;
  assigned_staff_id: string;
}

/** 型別化封裝:直接沿用 routingApi 的路徑與 mock/auto 行為。 */
export const routing = {
  queue: (skillGroupId?: string) => routingApi.queue(skillGroupId) as Promise<QueueResp>,
  agentLoads: (skillGroupId?: string) =>
    routingApi.agentLoads(skillGroupId) as Promise<RoutingAgentLoad[]>,
  listPolicies: () => routingApi.listPolicies() as Promise<RoutingPolicyDto[]>,
  autoAssign: (sessionId: string) => routingApi.autoAssign(sessionId) as Promise<AutoAssignResult>,
  assignTo: (sessionId: string, staffId: string) =>
    routingApi.assignTo(sessionId, staffId) as Promise<AssignResult>,
  claim: (sessionId: string) => routingApi.claim(sessionId) as Promise<AssignResult>,
  /** 設定/更新分派策略(需 routing.manage 權限)。routingApi 未提供,補於此。 */
  upsertPolicy: (body: {
    skill_group_id?: string | null;
    strategy: RoutingStrategy;
    max_load: number;
  }) => call<RoutingPolicyDto>({ path: "/api/v1/routing/policies", method: "PUT", body, real: true }),
};
