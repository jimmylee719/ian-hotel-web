import { PagePlaceholder } from "@/components/admin/PagePlaceholder";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "加購與折扣" };

export default async function Page() {
  await requirePage("commerce.edit");
  return <PagePlaceholder title="加購與折扣" />;
}
