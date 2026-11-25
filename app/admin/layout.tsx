import type { Metadata } from "next";
import { inArray } from "drizzle-orm";
import { AdminAuthError, requireStaff, type StaffContext } from "@/lib/admin/auth";
import { navItemsFor, ROLE_LABELS } from "@/lib/admin/nav";
import { currentProperty } from "@/lib/admin/property-scope";
import { getDb } from "@/lib/db/client";
import { properties } from "@/lib/db/schema";
import { AdminNav } from "@/components/admin/AdminNav";
import { PropertySwitcher } from "@/components/admin/PropertySwitcher";
import "./admin.css";

export const metadata: Metadata = {
  title: { default: "後台", template: "%s｜NK Hostel 後台" },
  robots: { index: false, follow: false },
};

// Always per-request: what a page shows depends on who is signed in.
export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW">
      <body className="adm-body">{children}</body>
    </html>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Shell>
      <main className="adm-notice">
        <h1>{title}</h1>
        <p>{children}</p>
      </main>
    </Shell>
  );
}

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  let ctx: StaffContext;
  try {
    ctx = await requireStaff("dashboard.view");
  } catch (e) {
    // Nothing from the database or the page is rendered on these two screens.
    if (e instanceof AdminAuthError && e.status === 401) {
      return <Notice title="請透過 Cloudflare Access 登入">登入狀態已失效或尚未登入。請重新整理頁面，依畫面指示以公司帳號登入。</Notice>;
    }
    if (e instanceof AdminAuthError) {
      return <Notice title="你沒有使用後台的權限">這個帳號不在員工名單中，或已停用。請聯絡店主開通。</Notice>;
    }
    throw e;
  }

  const db = await getDb();
  const rows = await db.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, ctx.staff.propertyIds));
  const options = ctx.staff.propertyIds
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({ id: r.id, name: r.name["zh-TW"] }));
  const current = await currentProperty(ctx);

  return (
    <Shell>
      <div className="adm">
        <aside className="adm-side">
          <div className="adm-brand">NK Hostel<span>後台</span></div>
          <AdminNav items={navItemsFor(ctx.staff).map(({ href, label }) => ({ href, label }))} />
        </aside>
        <div className="adm-main">
          <header className="adm-top">
            <PropertySwitcher properties={options} current={current} />
            <div className="adm-user">
              <span>{ctx.staff.name}</span>
              <span className="adm-role">{ROLE_LABELS[ctx.staff.role]}</span>
            </div>
          </header>
          <main className="adm-content">{children}</main>
        </div>
      </div>
    </Shell>
  );
}
