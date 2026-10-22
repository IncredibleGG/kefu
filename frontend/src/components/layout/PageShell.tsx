import type { ReactNode } from "react";

/** 一般頁面外殼:標題列 + 可捲動內容區
 *  手機版面(< md):標題列可換行、actions 自成一列可換行、描述在 < sm 最多兩行、內外距縮小;
 *  ≥ md 維持原樣。 */
export function PageShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-3.5 max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-2 max-md:px-4 max-md:py-3">
        <div className="max-md:min-w-0 max-md:flex-1">
          <h1 className="text-base font-semibold max-md:truncate">{title}</h1>
          {description && <p className="text-sm text-muted-foreground max-sm:line-clamp-2">{description}</p>}
        </div>
        {actions && <div className="contents max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-2">{actions}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-6 max-md:p-4">{children}</div>
    </div>
  );
}
