import { cn } from "@/lib/utils";

export function StatusDot({ className, pulse }: { className?: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex">
      <span className={cn("h-2.5 w-2.5 rounded-full", className)} />
      {pulse && (
        <span className={cn("absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full opacity-60", className)} />
      )}
    </span>
  );
}
