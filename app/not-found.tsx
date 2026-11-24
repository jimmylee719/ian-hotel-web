import Link from "next/link";

// Reached only for paths outside the locale segment (the middleware prefixes everything else).
export default function RootNotFound() {
  return (
    <html lang="zh-TW">
      <body>
        <main className="wrap not-found">
          <h1>404</h1>
          <p>
            <Link href="/zh-TW">小公館人文旅舍</Link> · <Link href="/en">NK Hostel</Link>
          </p>
        </main>
      </body>
    </html>
  );
}
