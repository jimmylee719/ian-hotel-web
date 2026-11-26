import { fontVariables } from "@/app/[locale]/fonts";

// Test-site tools (the mock payment page) live outside the localised site; the page sets its own `lang`.
export default function DevLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-TW" className={fontVariables}>
      <body>{children}</body>
    </html>
  );
}
