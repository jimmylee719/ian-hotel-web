import { syncStatusLabel, type Tone } from "@/lib/admin/sync-status";

const RESERVATION: Record<string, [string, Tone]> = {
  pending_payment: ["待付款", "amber"],
  paid_pending_confirm: ["已付款，待確認", "blue"],
  confirmed: ["已確認", "green"],
  confirm_failed_refunded: ["確認失敗，已退款", "red"],
  cancelled: ["已取消", "grey"],
  expired: ["已逾時", "grey"],
};

/**
 * Coloured label for a reservation `status` or a channel `syncState`. Unknown values show as-is in grey.
 * `channelConfigured` false (a sync badge): a pending sync reads 「通路未設定，待同步」 (see syncStatusLabel).
 */
export function StatusBadge({ status, kind = "reservation", channelConfigured = true }: {
  status: string; kind?: "reservation" | "sync"; channelConfigured?: boolean;
}) {
  const [label, tone] = kind === "sync" ? syncStatusLabel(status, channelConfigured) : RESERVATION[status] ?? [status, "grey" as Tone];
  return <span className={`adm-badge adm-badge-${tone}`}>{label}</span>;
}

/** Whether a piece of content is public (a room: 上架 / 下架). */
export function PublishBadge({ on, labels = ["公開", "未公開"] }: { on: boolean; labels?: [string, string] }) {
  return <span className={`adm-badge adm-badge-${on ? "green" : "grey"}`}>{on ? labels[0] : labels[1]}</span>;
}
