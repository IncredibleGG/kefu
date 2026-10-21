// 主動式訊息觸發引擎(瀏覽器端)。
//
// 職責:載入後端公開規則,於瀏覽器端評估各 trigger;命中且該規則的 frequency 允許時,
// 呼叫 onFire(rule) 交回 widget 呈現。設計要點:
//   - 一次頁面載入最多只「開火」一則(命中後 disarm 其餘,避免聊天窗被灌爆);
//     多規則同時命中時依 priority 由高到低取勝(後端已排序,這裡再保險排一次)。
//   - frequency 以 web storage 記錄避免洗版:
//       once_per_visitor → localStorage(跨分頁、跨 session 永久);
//       once_per_session → sessionStorage(單一分頁 session,關頁即清);
//       always          → 不記錄,每次都可觸發。
//   - visit_count 的「造訪次數」以 localStorage 累計,每個瀏覽 session 只 +1
//     (用 sessionStorage 當旗標,避免同分頁多次 reload 灌高次數)。
//   - 所有 storage 存取全 try/catch;隱私模式 / 停用 storage 一律安靜降級(不崩、不重複灌)。

import type { ProactiveRule } from "./types";

export interface ProactiveHandlers {
  /** 規則命中(且 frequency 允許)時呼叫;widget 依 rule.mode 呈現。 */
  onFire: (rule: ProactiveRule) => void;
}

export class ProactiveEngine {
  private rules: ProactiveRule[] = [];
  private fired = false;
  private cleanups: Array<() => void> = [];
  private readonly startedAt = Date.now();

  constructor(
    private readonly channelKey: string,
    private readonly handlers: ProactiveHandlers,
  ) {}

  /** 帶入公開規則並開始評估。無規則時直接返回。 */
  start(rules: ProactiveRule[]): void {
    if (!rules || !rules.length) return;
    this.rules = [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    this.recordVisit();

    // 先評估「即時型」規則(依 priority 高→低);命中即開火並停止其餘。
    for (const r of this.rules) {
      if (this.isImmediate(r.trigger.type) && this.evalImmediate(r)) {
        if (this.tryFire(r)) return;
      }
    }
    // 否則掛載「時間 / 事件型」偵測器,等待命中。
    for (const r of this.rules) {
      if (!this.isImmediate(r.trigger.type)) this.arm(r);
    }
  }

  /** 移除所有偵測器 / 計時器(命中後或 widget 銷毀時呼叫)。 */
  teardown(): void {
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* noop */
      }
    }
  }

  // ------------------------------------------------------------------ //
  // 觸發評估
  // ------------------------------------------------------------------ //
  private isImmediate(type: string): boolean {
    return type === "url_match" || type === "visit_count";
  }

  /** 即時型:載入當下即可判定(url_match / visit_count)。 */
  private evalImmediate(rule: ProactiveRule): boolean {
    const { type, params = {} } = rule.trigger;
    if (type === "url_match") return this.matchUrl(params);
    if (type === "visit_count") return this.matchVisitCount(params);
    return false;
  }

  /** 時間 / 事件型:掛偵測器,命中呼叫 tryFire。 */
  private arm(rule: ProactiveRule): void {
    const { type, params = {} } = rule.trigger;

    if (type === "time_on_page") {
      const seconds = this.num(params.seconds ?? params.delay, 15);
      const elapsed = (Date.now() - this.startedAt) / 1000;
      const remain = Math.max(0, seconds - elapsed) * 1000;
      const t = window.setTimeout(() => this.tryFire(rule), remain);
      this.cleanups.push(() => clearTimeout(t));
      return;
    }

    if (type === "scroll_depth") {
      const target = this.num(params.percent ?? params.depth, 50);
      const onScroll = () => {
        if (this.scrollPercent() >= target) this.tryFire(rule);
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      this.cleanups.push(() => window.removeEventListener("scroll", onScroll));
      // 頁面本來就已捲過門檻(或不可捲動)時,載入即命中。
      onScroll();
      return;
    }

    if (type === "exit_intent") {
      const onOut = (e: MouseEvent) => {
        // 游標往視窗頂端外移(relatedTarget 為 null = 離開文件)= 關頁意圖。
        if (e.clientY <= 0 && !e.relatedTarget) this.tryFire(rule);
      };
      document.addEventListener("mouseout", onOut);
      this.cleanups.push(() => document.removeEventListener("mouseout", onOut));
      return;
    }
  }

  private matchUrl(params: Record<string, unknown>): boolean {
    const pattern = String(params.pattern ?? params.url ?? "");
    if (!pattern) return false;
    const href = location.href;
    const path = location.pathname + location.search;
    const mode = String(params.match ?? params.mode ?? "contains");
    try {
      if (mode === "regex") {
        const re = new RegExp(pattern);
        return re.test(href) || re.test(path);
      }
      if (mode === "exact") return href === pattern || path === pattern;
      if (mode === "prefix") return href.startsWith(pattern) || path.startsWith(pattern);
      // 含 * 走萬用字元(對 href 與 path 皆試)。
      if (pattern.includes("*")) {
        const re = new RegExp(
          "^" + pattern.split("*").map((s) => this.escapeRe(s)).join(".*") + "$",
        );
        return re.test(href) || re.test(path);
      }
      return href.includes(pattern);
    } catch {
      return false;
    }
  }

  private matchVisitCount(params: Record<string, unknown>): boolean {
    const visits = this.getVisitCount();
    const count = this.num(params.count ?? params.min ?? params.n, 1);
    const op = String(params.op ?? "gte");
    if (op === "eq") return visits === count;
    if (op === "lte") return visits <= count;
    return visits >= count;
  }

  private scrollPercent(): number {
    const doc = document.documentElement;
    const scrolled = window.scrollY || doc.scrollTop || 0;
    const range = doc.scrollHeight - doc.clientHeight;
    if (range <= 0) return 100; // 不可捲動的短頁視為 100%
    return Math.min(100, Math.round((scrolled / range) * 100));
  }

  // ------------------------------------------------------------------ //
  // 開火 + frequency 控制
  // ------------------------------------------------------------------ //
  /** 嘗試開火:已開火過 / frequency 不允許則跳過。真正開火回 true。 */
  private tryFire(rule: ProactiveRule): boolean {
    if (this.fired) return false;
    if (!this.canFire(rule)) return false;
    this.fired = true;
    this.markFired(rule);
    this.teardown();
    try {
      this.handlers.onFire(rule);
    } catch {
      /* 呈現失敗不影響引擎 */
    }
    return true;
  }

  private canFire(rule: ProactiveRule): boolean {
    if (rule.frequency === "always") return true;
    return !this.readFlag(this.firedKey(rule.id), rule.frequency);
  }

  private markFired(rule: ProactiveRule): void {
    if (rule.frequency === "always") return;
    this.writeFlag(this.firedKey(rule.id), rule.frequency);
  }

  // ------------------------------------------------------------------ //
  // 造訪次數(每個瀏覽 session +1)
  // ------------------------------------------------------------------ //
  private recordVisit(): void {
    // 本 session 已計過就不重複累計(避免同分頁 reload 灌高)。
    const sessionMark = this.key("visit_counted");
    try {
      if (sessionStorage.getItem(sessionMark)) return;
    } catch {
      /* 讀不到就當作尚未計 */
    }
    const next = this.getVisitCount() + 1;
    try {
      localStorage.setItem(this.key("visits"), String(next));
    } catch {
      /* 無法寫入則放棄累計(降級) */
    }
    try {
      sessionStorage.setItem(sessionMark, "1");
    } catch {
      /* noop */
    }
  }

  private getVisitCount(): number {
    try {
      const v = Number(localStorage.getItem(this.key("visits")) || "0");
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }

  // ------------------------------------------------------------------ //
  // storage 輔助(以 channelKey 命名空間;全 try/catch 降級)
  // ------------------------------------------------------------------ //
  private key(k: string): string {
    return `kefu_proactive:${this.channelKey}:${k}`;
  }
  private firedKey(ruleId: string): string {
    return this.key(`fired:${ruleId}`);
  }

  /** once_per_visitor → localStorage;once_per_session → sessionStorage。 */
  private store(freq: string): Storage | null {
    try {
      return freq === "once_per_visitor" ? window.localStorage : window.sessionStorage;
    } catch {
      return null;
    }
  }
  private readFlag(k: string, freq: string): boolean {
    try {
      return this.store(freq)?.getItem(k) === "1";
    } catch {
      return false;
    }
  }
  private writeFlag(k: string, freq: string): void {
    try {
      this.store(freq)?.setItem(k, "1");
    } catch {
      /* 隱私模式等情況忽略 */
    }
  }

  private num(v: unknown, dflt: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }
  private escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
