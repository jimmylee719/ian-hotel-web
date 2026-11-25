import { PagePlaceholder } from "@/components/admin/PagePlaceholder";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "內容" };

export default async function Page() {
  await requirePage("content.edit");
  return <PagePlaceholder title="內容" />;
}
