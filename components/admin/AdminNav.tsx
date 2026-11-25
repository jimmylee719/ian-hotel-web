"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Side menu. The server decides which items to pass (only what the staff member may open). */
export function AdminNav({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav className="adm-nav" aria-label="後台選單">
      {items.map((i) => {
        const active = path === i.href || path.startsWith(`${i.href}/`);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
