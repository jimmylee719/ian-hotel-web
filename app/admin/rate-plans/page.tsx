import { PagePlaceholder } from "@/components/admin/PagePlaceholder";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "房價方案" };

export default async function Page() {
  await requirePage("commerce.edit");
  return <PagePlaceholder title="房價方案" />;
}
