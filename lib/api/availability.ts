import { eq } from "drizzle-orm";
import { z } from "zod";
import { searchAvailability } from "@/lib/db/ari-repo";
import { properties } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

const Query = z.object({
  property: z.string().min(1),
  checkIn: z.string(),
  checkOut: z.string(),
  adults: z.coerce.number().int().min(1).max(12),
  rooms: z.coerce.number().int().min(1).max(6).default(1),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handleAvailability(db: Db, url: URL): Promise<Response> {
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return json(400, { error: "INVALID_QUERY", issues: parsed.error.issues.map((i) => i.path.join(".")) });
  const q = parsed.data;

  const [property] = await db.select({ id: properties.id }).from(properties).where(eq(properties.slug, q.property));
  if (!property) return json(404, { error: "PROPERTY_NOT_FOUND" });

  const r = await searchAvailability(db, { propertyId: property.id, checkIn: q.checkIn, checkOut: q.checkOut, adults: q.adults, rooms: q.rooms });
  if (!r.ok) return json(400, { error: r.error });

  return json(200, {
    offers: r.offers.map((o) => ({
      unitType: { slug: o.unitType.slug, name: o.unitType.name, maxOccupancy: o.unitType.maxOccupancy },
      ratePlan: { slug: o.ratePlan.slug, name: o.ratePlan.name, includesBreakfast: o.ratePlan.includesBreakfast },
      nightlyPrices: o.nightlyPrices,
      roomSubtotal: o.roomSubtotal,
      availableUnits: o.availableUnits,
    })),
  });
}
