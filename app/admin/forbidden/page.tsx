import Link from "next/link";

export const metadata = { title: "沒有權限" };

// No data here: it is the landing spot for any 403 inside the admin.
export default function Forbidden() {
  return (
    <>
      <h1 className="adm-h1">你沒有這個頁面的權限</h1>
      <p>目前的帳號無法開啟這個功能。如果需要使用，請聯絡店主調整權限。</p>
      <p><Link href="/admin/dashboard">回到總覽</Link></p>
    </>
  );
}
