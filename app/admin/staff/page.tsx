import { PagePlaceholder } from "@/components/admin/PagePlaceholder";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "員工" };

export default async function Page() {
  await requirePage("staff.manage");
  return <PagePlaceholder title="員工" />;
}
