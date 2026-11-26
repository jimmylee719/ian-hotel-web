/**
 * One of our SiteMinder codes (lib/channel/siteminder/codes.ts), read-only: staff give it to SiteMinder for the
 * hotel's room / rate mapping. It is written once and never edited (a change breaks that mapping).
 */
export function SmCode({ label, code }: { label: string; code: string | null }) {
  return (
    <p className="adm-muted">
      SiteMinder {label}：{code ? <code>{code}</code> : "（尚未產生）"}　交給 SiteMinder 對應用（不能修改）。
    </p>
  );
}
