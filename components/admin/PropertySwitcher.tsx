"use client";

import { useTransition } from "react";
import { setAdminProperty } from "@/app/admin/actions";

/** Which property the admin is showing. One property: a plain label. Several: a select that saves the choice. */
export function PropertySwitcher({
  properties, current,
}: { properties: { id: string; name: string }[]; current: string }) {
  const [pending, start] = useTransition();
  if (properties.length <= 1) return <span className="adm-property">{properties[0]?.name ?? ""}</span>;
  return (
    <label className="adm-property">
      <span className="adm-muted">館別</span>
      <select
        value={current}
        disabled={pending}
        onChange={(e) => { const id = e.target.value; start(async () => { await setAdminProperty(id); }); }}
      >
        {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
  );
}
