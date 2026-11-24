// Dev-only tools (e.g. the mock payment page) live outside the localised site.
export default function DevLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  );
}
