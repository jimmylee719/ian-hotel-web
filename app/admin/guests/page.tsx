import { PagePlaceholder } from "@/components/admin/PagePlaceholder";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "旅客" };

export default async function Page() {
  await requirePage("reservations.view");
  return <PagePlaceholder title="旅客" />;
}
