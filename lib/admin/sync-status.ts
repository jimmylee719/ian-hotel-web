export type Tone = "amber" | "blue" | "green" | "red" | "grey";

const SYNC: Record<string, [string, Tone]> = {
  not_required: ["無需同步", "grey"],
  pending: ["同步中", "amber"],
  synced: ["已同步", "green"],
  failed: ["同步失敗", "red"],
};

/**
 * The label and colour of a channel `syncState`. With no channel configured (CHANNEL_MODE unset) nothing syncs
 * until one is, so a pending sync reads 「通路未設定，待同步」 rather than 同步中. Unknown values show as-is in grey.
 */
export function syncStatusLabel(syncState: string, channelConfigured: boolean): [string, Tone] {
  if (syncState === "pending" && !channelConfigured) return ["通路未設定，待同步", "amber"];
  return SYNC[syncState] ?? [syncState, "grey"];
}
