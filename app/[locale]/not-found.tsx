import { useTranslations } from "next-intl";
import { PageHead } from "@/components/site/PageHead";
import { Link } from "@/i18n/navigation";

export default function NotFound() {
  const t = useTranslations("notFound");
  return (
    <main id="main" className="wrap not-found">
      <PageHead title={t("title")} lead={t("body")} />
      <p>
        <Link href="/">{t("back")}</Link>
      </p>
    </main>
  );
}
