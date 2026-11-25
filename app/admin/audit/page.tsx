import { PagePlaceholder } from "@/components/admin/PagePlaceholder";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "操作紀錄" };

export default async function Page() {
  await requirePage("audit.view");
  return <PagePlaceholder title="操作紀錄" />;
}
