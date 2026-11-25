type Tone = "amber" | "blue" | "green" | "red" | "grey";

const RESERVATION: Record<string, [string, Tone]> = {
  pending_payment: ["待付款", "amber"],
  paid_pending_confirm: ["已付款，待確認", "blue"],
  confirmed: ["已確認", "green"],
  confirm_failed_refunded: ["確認失敗，已退款", "red"],
  cancelled: ["已取消", "grey"],
  expired: ["已逾時", "grey"],
};

const SYNC: Record<string, [string, Tone]> = {
  not_required: ["無需同步", "grey"],
  pending: ["同步中", "amber"],
  synced: ["已同步", "green"],
  failed: ["同步失敗", "red"],
};

/** Coloured label for a reservation `status` or a channel `syncState`. Unknown values show as-is in grey. */
export function StatusBadge({ status, kind = "reservation" }: { status: string; kind?: "reservation" | "sync" }) {
  const [label, tone] = (kind === "sync" ? SYNC : RESERVATION)[status] ?? [status, "grey" as Tone];
  return <span className={`adm-badge adm-badge-${tone}`}>{label}</span>;
}
