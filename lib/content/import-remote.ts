/**
 * The planning half of scripts/import-content-remote.ts: turns the migrated site content (content/old-site.json,
 * via oldSiteContent; its photos are R2 keys) into SQL for a remote D1, with no I/O, so it is tested against
 * better-sqlite3 with the real migrations and never touches a remote.
 *
 * Insert-only, like seedContent, and enforced by the SQL itself (the plan cannot see the remote database):
 * - a room's description / bed type / amenities / size / photos are filled only where that field is still blank;
 * - content pages, FAQs and news are inserted only when the property has no row with that slug.
 * Every statement is scoped to the property by slug, so a database without it gets nothing. Running it twice
 * changes nothing the second time.
 */
import type { OldSiteContent } from "./types";
import { LOCALES, type I18n } from "@/lib/db/schema";

export type ImportEnv = "staging" | "production" | "preview";

export type ImportPlan = {
  /** One SQL statement each, in order. */
  statements: string[];
  /** Human-readable list of what would be written (each only if missing / blank there). */
  summary: string[];
  /** R2 keys the content refers to: they must already be in the environment's bucket. */
  imageKeys: string[];
};

const str = (v: string) => `'${v.replaceAll("'", "''")}'`;
const json = (v: unknown) => str(JSON.stringify(v));
const num = (v: number | null) => (v === null ? "NULL" : String(Math.trunc(v)));

/** SQL: every locale of an I18n JSON column is empty or whitespace (seedContent's `blank`). */
const blankI18n = (col: string) =>
  `(${LOCALES.map((l) => `trim(coalesce(json_extract(${col}, '$."${l}"'), '')) = ''`).join(" and ")})`;

export function planContentImport(
  data: OldSiteContent, o: { propertySlug: string; now: number; newId: () => string },
): ImportPlan {
  const prop = `(select id from properties where slug = ${str(o.propertySlug)})`;
  const statements: string[] = [];
  const summary: string[] = [];

  for (const r of data.rooms) {
    const where = `property_id = ${prop} and slug = ${str(r.slug)}`;
    const fills: [col: string, value: string, blank: string][] = [
      ["description", json(r.description), blankI18n("description")],
      ["bed_type", json(r.bedType), blankI18n("bed_type")],
      ["amenities", json(r.amenities), "json_array_length(amenities) = 0"],
      ["size_sqm", num(r.sizeSqm), "size_sqm is null"],
      ["images", json(r.images), "json_array_length(images) = 0"],
    ];
    for (const [col, value, blank] of fills) statements.push(`UPDATE unit_types SET ${col} = ${value} WHERE ${where} AND ${blank};`);
    summary.push(`unit_types ${r.slug}: fill blank description, bed type, amenities, size, ${r.images.length} photos`);
  }

  const tables: [table: string, rows: { slug: string; title: I18n; body: I18n; sortOrder: number; publishedAt?: number | null }[]][] = [
    ["content_pages", data.pages],
    ["faqs", data.faqs],
    ["news", data.news.map((n, i) => ({ ...n, sortOrder: i }))],
  ];
  for (const [table, rows] of tables) {
    for (const row of rows) {
      const publishedAt = row.publishedAt === undefined ? o.now : row.publishedAt;
      statements.push(
        `INSERT INTO ${table} (id, property_id, slug, title, body, published_at, sort_order) ` +
        `SELECT ${str(o.newId())}, p.id, ${str(row.slug)}, ${json(row.title)}, ${json(row.body)}, ${num(publishedAt)}, ${num(row.sortOrder)} ` +
        `FROM properties p WHERE p.slug = ${str(o.propertySlug)} ` +
        `AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.property_id = p.id AND t.slug = ${str(row.slug)});`,
      );
    }
    summary.push(`${table}: ${rows.length} (inserted only if the slug is missing): ${rows.map((r) => r.slug).join(", ")}`);
  }

  const imageKeys = [...new Set([...data.rooms, ...data.pages, ...data.news].flatMap((x) => x.images))].sort();
  return { statements, summary, imageKeys };
}

export type ImportArgs = { ok: true; env: ImportEnv; apply: boolean } | { ok: false; error: string };

/**
 * `[--env staging|production] [--apply] [--yes]`. Default: a dry run against staging. `--apply` writes;
 * writing to production also needs `--yes`.
 */
export function parseImportArgs(argv: string[]): ImportArgs {
  let env: ImportEnv = "staging";
  let apply = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env") {
      const v = argv[++i];
      if (v !== "staging" && v !== "production" && v !== "preview") return { ok: false, error: `--env must be staging, production or preview, got ${v ?? "nothing"}` };
      env = v;
    } else if (a === "--apply") apply = true;
    else if (a === "--yes") yes = true;
    else return { ok: false, error: `unknown argument ${a}` };
  }
  if (apply && env === "production" && !yes) return { ok: false, error: "writing to production needs --env production --apply --yes" };
  return { ok: true, env, apply };
}

/** The one remote write: `wrangler d1 execute DB --env <env> --remote --file <file>` (DB is the D1 binding). */
export function wranglerExecuteArgs(env: ImportEnv, file: string): string[] {
  return ["wrangler", "d1", "execute", "DB", "--env", env, "--remote", "--file", file];
}
