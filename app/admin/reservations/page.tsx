import { PagePlaceholder } from "@/components/admin/PagePlaceholder";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "訂單" };

export default async function Page() {
  await requirePage("reservations.view");
  return <PagePlaceholder title="訂單" />;
}
