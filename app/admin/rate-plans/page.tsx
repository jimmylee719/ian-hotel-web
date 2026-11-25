import { redirect } from "next/navigation";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "房價方案" };

/** The menu's 房價方案 entry; the editor lives with the other commerce settings. */
export default async function Page() {
  await requirePage("commerce.edit");
  redirect("/admin/commerce/rate-plans");
}
