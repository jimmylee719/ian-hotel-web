import { requirePage } from "@/lib/admin/page-guard";
import { getSystemStatus, MODE_UNKNOWN, type SystemWarning } from "@/lib/admin/system-status";
import { getDb } from "@/lib/db/client";
import { appEnv } from "@/lib/runtime/env";

export const metadata = { title: "系統狀態" };

const time = (ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "medium" }).format(ms);

const WARNINGS: Record<SystemWarning, string> = {
  DEV_STAFF_EMAIL_LOCAL_BYPASS: "本機模式：已略過 Cloudflare Access（DEV_STAFF_EMAIL 生效中，所有後台請求都以這個員工身分執行）。",
  DEV_STAFF_EMAIL_SET_OUTSIDE_LOCAL: "DEV_STAFF_EMAIL 不應該在本機以外設定，請立即從部署的 secret 移除（本機以外它不會生效，但不該存在）。",
  ACCESS_NOT_CONFIGURED: "Cloudflare Access 尚未設定（CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD），後台會拒絕所有登入。",
  MIGRATIONS_BEHIND: "資料庫的 migration 比程式舊，請執行 wrangler d1 migrations apply。",
};
const SYNC_LABELS: Record<string, string> = { not_required: "不需同步", pending: "等待同步", synced: "已同步", failed: "同步失敗" };
const VERDICT_LABELS: Record<string, string> = {
  accepted: "已接受", duplicate: "重複通知", bad_signature: "簽章錯誤", amount_mismatch: "金額不符",
  unknown_reservation: "找不到訂單", stray_charge: "多餘扣款",
};

export default async function Page() {
  const ctx = await requirePage("audit.view");
  const s = await getSystemStatus(await getDb(), await appEnv(), { propertyIds: ctx.staff.propertyIds });
  const counts = (rec: Record<string, number>, labels: Record<string, string>) =>
    Object.keys(rec).length === 0 ? <p className="adm-muted">沒有資料</p> : (
      <dl className="adm-dl">
        {Object.entries(rec).map(([k, n]) => <div key={k} style={{ display: "contents" }}><dt>{labels[k] ?? k}</dt><dd className="adm-num">{n}</dd></div>)}
      </dl>
    );

  return (
    <>
      <h1 className="adm-h1">系統狀態</h1>
      {s.warnings.length ? <ul className="adm-alerts">{s.warnings.map((w) => <li key={w} style={{ padding: "8px 12px" }}>{WARNINGS[w]}</li>)}</ul> : null}
      <div className="adm-grid">
        <section className="adm-card">
          <h2 className="adm-h2">執行模式</h2>
          <dl className="adm-dl">
            {Object.entries(s.modes).map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt><code>{k}</code></dt><dd>{v === MODE_UNKNOWN ? <span className="adm-badge adm-badge-red">{v}</span> : v}</dd></div>)}
            <dt>線上訂房</dt><dd>{s.bookingDisabledReason ? <>關閉（<code>{s.bookingDisabledReason}</code>）</> : "開啟"}</dd>
            <dt>Cloudflare Access</dt><dd>{s.accessConfigured ? "已設定" : "未設定"}</dd>
          </dl>
        </section>
        <section className="adm-card">
          <h2 className="adm-h2">設定與金鑰（不顯示內容）</h2>
          <dl className="adm-dl">
            {s.settings.map((x) => (
              <div key={x.name} style={{ display: "contents" }}>
                <dt><code>{x.name}</code></dt>
                <dd><span className={`adm-badge adm-badge-${x.set ? "green" : "grey"}`}>{x.set ? "已設定" : "未設定"}</span></dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="adm-card">
          <h2 className="adm-h2">排程（每 5 分鐘）</h2>
          {s.lastJobRun ? (
            <dl className="adm-dl">
              <dt>上次執行</dt><dd className="adm-num">{time(s.lastJobRun.startedAt)}</dd>
              <dt>耗時</dt><dd className="adm-num">{s.lastJobRun.finishedAt - s.lastJobRun.startedAt} ms</dd>
              <dt>結果</dt><dd><code>{JSON.stringify(s.lastJobRun.result)}</code></dd>
            </dl>
          ) : <p className="adm-muted">還沒有執行紀錄</p>}
        </section>
        <section className="adm-card">
          <h2 className="adm-h2">訂單同步狀態</h2>
          {counts(s.syncStates, SYNC_LABELS)}
        </section>
        <section className="adm-card">
          <h2 className="adm-h2">最近 24 小時金流通知</h2>
          {counts(s.paymentVerdicts24h, VERDICT_LABELS)}
        </section>
        <section className="adm-card">
          <h2 className="adm-h2">資料庫 migration</h2>
          <dl className="adm-dl">
            <dt>已套用</dt><dd className="adm-num">{s.migrations.applied} / {s.migrations.expected}</dd>
            <dt>最新</dt><dd><code>{s.migrations.latest ?? "—"}</code></dd>
            <dt>程式版本</dt><dd><code>{s.migrations.expectedLatest}</code></dd>
          </dl>
        </section>
      </div>
    </>
  );
}
