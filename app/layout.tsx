import "./globals.css";
import "./site.css";

// The <html> element lives in app/[locale]/layout.tsx (and app/dev/layout.tsx) so `lang` can follow
// the locale. This outermost layout only carries the global stylesheet.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
