import { PagePlaceholder } from "@/components/admin/PagePlaceholder";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "報表" };

export default async function Page() {
  await requirePage("reports.view");
  return <PagePlaceholder title="報表" />;
}
