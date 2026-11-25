import Link from "next/link";
import { requirePage } from "@/lib/admin/page-guard";

export const metadata = { title: "加購與折扣" };

const SECTIONS: [href: string, title: string, blurb: string][] = [
  ["/admin/commerce/addons", "加購項目", "早餐、接送等可加購的項目與價格。"],
  ["/admin/commerce/promos", "折扣碼", "折扣碼、有效期間與使用上限。"],
  ["/admin/commerce/rate-plans", "房價方案", "取消規則、付款方式與訂金（房價與庫存請在 SiteMinder 調整）。"],
  ["/admin/commerce/property", "館別設定", "地址、電話、入住與退房時間、交通說明。"],
];

export default async function Page() {
  await requirePage("commerce.edit");
  return (
    <>
      <h1 className="adm-h1">加購與折扣</h1>
      <div className="adm-grid">
        {SECTIONS.map(([href, title, blurb]) => (
          <Link key={href} href={href} className="adm-card">
            <h2 className="adm-h2">{title}</h2>
            <p className="adm-muted">{blurb}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
