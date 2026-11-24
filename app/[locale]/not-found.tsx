import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

export default function NotFound() {
  const t = useTranslations("notFound");
  return (
    <main id="main" className="wrap not-found">
      <h1>{t("title")}</h1>
      <p>{t("body")}</p>
      <p>
        <Link href="/">{t("back")}</Link>
      </p>
    </main>
  );
}
