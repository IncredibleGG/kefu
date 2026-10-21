import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-center">
      <p className="text-6xl font-bold text-brand">404</p>
      <p className="text-muted-foreground">{t("core.notFoundMessage")}</p>
      <Button asChild>
        <Link to="/workspace">{t("core.notFoundBackToWorkspace")}</Link>
      </Button>
    </div>
  );
}
