/**
 * 組織樹 / 部門管理 API(乾淨室,直接走 ./client;不動 endpoints.ts)。
 *
 * 對應後端:
 * - tenancy.py 組織 CRUD(prefix /api/v1/tenancy):
 *     GET    /organizations?tree=true   → { tree, total }(巢狀樹,每節點含 children)
 *     POST   /organizations             → 建立(body: name, parent_id?)   需 organization.manage
 *     PATCH  /organizations/{id}        → 更新(body: name?, parent_id?)  需 organization.manage;後端防環
 *     DELETE /organizations/{id}        → 軟刪(直接子節點 parent_id SET NULL 升為頂層)需 organization.manage
 * - iam.py 坐席掛部門(prefix /api/v1/iam;選填能力):
 *     GET    /staff?organization_id=..  → { items }(需 staff.view)
 *     PATCH  /staff/{id}                → body organization_id 掛/卸部門(需 staff.manage)
 *
 * 回應信封由 client 的 call() 拆封,回傳 envelope.data。
 */
import { call } from "./client";

/** 組織 / 部門節點(tree=true 時含 children)。 */
export interface OrgNode {
  id: string;
  name: string;
  parent_id: string | null;
  tenant_id: string;
  created_at: string | null;
  children?: OrgNode[];
}

/** 坐席精簡列(掛部門用;後端 list 不含角色)。 */
export interface OrgStaff {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  organization_id: string | null;
  status: string;
  is_active: boolean;
}

const BASE = "/api/v1/tenancy/organizations";
const STAFF_BASE = "/api/v1/iam/staff";

export const organizationApi = {
  /** 取巢狀組織樹(根節點陣列;無後端時回空樹以利 demo)。 */
  tree: () =>
    call<{ tree: OrgNode[]; total: number }>({
      path: BASE,
      params: { tree: true },
      real: true,
      mock: async () => ({ tree: [], total: 0 }),
    }).then((r) => r?.tree ?? []),

  /** 建立部門(parent_id 省略/為 null → 頂層)。 */
  create: (body: { name: string; parent_id?: string | null }) =>
    call<OrgNode>({ path: BASE, method: "POST", body, real: true }),

  /** 更新部門:重命名或改上層(後端會擋環)。 */
  update: (id: string, body: { name?: string; parent_id?: string | null }) =>
    call<OrgNode>({ path: `${BASE}/${id}`, method: "PATCH", body, real: true }),

  /** 軟刪部門;其直接子節點會被提升為頂層。 */
  remove: (id: string) =>
    call<{ id: string; deleted: boolean }>({
      path: `${BASE}/${id}`,
      method: "DELETE",
      real: true,
    }),

  /** 某部門下的坐席(需 staff.view)。 */
  staffInOrg: (organizationId: string) =>
    call<{ items: OrgStaff[]; total: number }>({
      path: STAFF_BASE,
      params: { organization_id: organizationId, size: 200 },
      real: true,
      mock: async () => ({ items: [], total: 0 }),
    }).then((r) => r?.items ?? []),

  /** 全部坐席(供指派挑選;q 可模糊搜尋,需 staff.view)。 */
  allStaff: (q?: string) =>
    call<{ items: OrgStaff[]; total: number }>({
      path: STAFF_BASE,
      params: { q, size: 200 },
      real: true,
      mock: async () => ({ items: [], total: 0 }),
    }).then((r) => r?.items ?? []),

  /** 把坐席掛到部門(organizationId=null → 卸下;需 staff.manage)。 */
  assignStaff: (staffId: string, organizationId: string | null) =>
    call<OrgStaff>({
      path: `${STAFF_BASE}/${staffId}`,
      method: "PATCH",
      body: { organization_id: organizationId },
      real: true,
    }),
};

/* ------------------------------- 樹工具 ------------------------------- */

/** 攤平樹為節點陣列(深度優先)。 */
export function flattenTree(nodes: OrgNode[]): OrgNode[] {
  const out: OrgNode[] = [];
  const walk = (list: OrgNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 蒐集某節點自身 + 所有後代的 id(防環:這些不可當它的新上層)。 */
export function collectSubtreeIds(node: OrgNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: OrgNode) => {
    ids.add(n.id);
    n.children?.forEach(walk);
  };
  walk(node);
  return ids;
}
