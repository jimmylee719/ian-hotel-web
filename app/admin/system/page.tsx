import { PagePlaceholder } from "@/components/admin/PagePlaceholder";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "系統狀態" };

export default async function Page() {
  await requirePage("audit.view");
  return <PagePlaceholder title="系統狀態" />;
}
