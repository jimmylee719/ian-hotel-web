import { PagePlaceholder } from "@/components/admin/PagePlaceholder";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "總覽" };

export default async function Page() {
  await requirePage("dashboard.view");
  return <PagePlaceholder title="總覽" />;
}
