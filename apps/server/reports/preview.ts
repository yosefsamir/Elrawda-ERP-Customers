import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  computeItemLedger,
  computeItemPerformance,
  type InventorySnapshot,
} from "../../../packages/erp/inventory-performance.js";
import {
  loadInventoryFromSql,
  loadReportCatalogFromSql,
  readReportSqlConfig,
  type ReportSqlConfig,
} from "./sql-source.js";

const catalogSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), parentId: z.string().nullable(), level: z.enum(["type", "section", "classification", "size", "model", "product"]), label: z.string(), code: z.string().optional() })).max(100_000),
  locations: z.array(z.object({ id: z.string(), label: z.string(), stores: z.array(z.object({ id: z.string(), label: z.string() })) })).max(1000),
  source: z.object({ label: z.string(), readAt: z.iso.datetime() }),
});

const itemPerformanceRequestSchema = z.object({
  baseline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  productIds: z.array(z.string().min(1)).max(50_000).nullable().optional(),
  branchIds: z.array(z.string().min(1)).max(1_000).nullable().optional(),
  storeKeys: z.array(z.string().min(1)).max(5_000).nullable().optional(),
});

const itemLedgerRequestSchema = z.object({
  baseline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branchId: z.string().min(1),
  storeId: z.string().min(1),
  productId: z.string().min(1),
});

function isPrivateLanIp(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, "");
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  const m172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(normalized);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  return false;
}

function isPreviewRequestAllowed(request: FastifyRequest, allowLan: boolean): boolean {
  const peer = request.raw.socket.remoteAddress ?? "";
  const proxied = Object.keys(request.headers).some(
    name => name === "forwarded" || name.startsWith("x-forwarded-") || name.startsWith("tailscale-"),
  );
  if (proxied) return false;

  if (allowLan) {
    return isPrivateLanIp(peer);
  }

  // Strict loopback-only check by default
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.host ?? "");
  const origin = request.headers.origin;
  const localOrigin = !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
  return localHost && localOrigin && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer);
}

function addOneDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

export type ReportsRouteOptions = {
  authorize?: (request: FastifyRequest) => { statusCode: number; error: string } | null;
  resolveSqlConfig?: (request: FastifyRequest) => Promise<ReportSqlConfig | null>;
};

/** Local/LAN reports preview supporting either static JSON snapshots or live ERP SQL config. */
export async function registerReportsPreview(
  app: FastifyInstance,
  root: string,
  catalogFile = process.env.EMOJI_REPORT_FILTER_CATALOG_FILE,
  inventoryFile = process.env.EMOJI_REPORT_INVENTORY_FILE,
  sqlConfigFile = process.env.EMOJI_REPORT_SQL_CONFIG,
  allowLan = process.env.EMOJI_REPORT_ALLOW_LAN === "1",
  options?: ReportsRouteOptions,
) {
  const directory = resolve(root, "dist/reports");
  if (!existsSync(resolve(directory, "index.html"))) return;

  let cachedInventory: { key: string; mtimeMs: number; expiresAt: number; snapshot: InventorySnapshot } | null = null;
  let cachedCatalog: { key: string; expiresAt: number; payload: z.infer<typeof catalogSchema> } | null = null;

  function checkRouteAccess(request: FastifyRequest): { statusCode: number; error: string } | null {
    if (options?.authorize) {
      return options.authorize(request);
    }
    if (!isPreviewRequestAllowed(request, allowLan)) {
      return { statusCode: 403, error: "Local preview only" };
    }
    return null;
  }

  async function getActiveSqlConfig(request: FastifyRequest): Promise<{ key: string; config: ReportSqlConfig } | null> {
    if (sqlConfigFile) {
      return { key: sqlConfigFile, config: await readReportSqlConfig(sqlConfigFile) };
    }
    if (options?.resolveSqlConfig) {
      const config = await options.resolveSqlConfig(request);
      if (config) {
        return { key: `${config.server}:${config.port ?? ""}:${config.instance}:${config.database}`, config };
      }
    }
    return null;
  }

  async function resolveInventorySnapshot(toDate: string, request: FastifyRequest): Promise<InventorySnapshot> {
    const sqlEntry = await getActiveSqlConfig(request);
    if (sqlEntry) {
      const untilExclusive = addOneDay(toDate);
      const cacheKey = `${sqlEntry.key}|${untilExclusive}`;
      const now = Date.now();
      if (cachedInventory && cachedInventory.key === cacheKey && cachedInventory.expiresAt > now) {
        return cachedInventory.snapshot;
      }
      const snapshot = await loadInventoryFromSql(sqlEntry.config, root, untilExclusive);
      cachedInventory = { key: cacheKey, mtimeMs: 0, expiresAt: now + 5 * 60_000, snapshot };
      return snapshot;
    }
    if (!inventoryFile) {
      throw Object.assign(new Error("ERP inventory source is not configured"), { statusCode: 503 });
    }
    const info = await stat(inventoryFile);
    if (cachedInventory && cachedInventory.key === inventoryFile && cachedInventory.mtimeMs === info.mtimeMs) {
      return cachedInventory.snapshot;
    }
    const content = await readFile(inventoryFile, "utf8");
    const snapshot = JSON.parse(content) as InventorySnapshot;
    cachedInventory = { key: inventoryFile, mtimeMs: info.mtimeMs, expiresAt: Number.MAX_SAFE_INTEGER, snapshot };
    return snapshot;
  }

  await app.register(async scope => {
    scope.get("/api/reports/filter-options", async (request, reply) => {
      const denied = checkRouteAccess(request);
      if (denied) return reply.code(denied.statusCode).send({ error: denied.error });
      reply.header("Cache-Control", "no-store");

      try {
        const sqlEntry = await getActiveSqlConfig(request);
        if (sqlEntry) {
          const now = Date.now();
          if (cachedCatalog && cachedCatalog.key === sqlEntry.key && cachedCatalog.expiresAt > now) {
            return reply.send(cachedCatalog.payload);
          }
          const payload = catalogSchema.parse(await loadReportCatalogFromSql(sqlEntry.config));
          cachedCatalog = { key: sqlEntry.key, expiresAt: now + 15 * 60_000, payload };
          return reply.send(payload);
        }
      } catch {
        return reply.code(503).send({ error: "ERP SQL filter source is unavailable" });
      }

      if (!catalogFile) return reply.code(503).send({ error: "ERP filter source is not configured" });
      try {
        const content = await readFile(catalogFile, "utf8");
        if (content.length > 20_000_000) throw new Error("Catalog exceeds preview limit");
        return reply.send(catalogSchema.parse(JSON.parse(content)));
      } catch {
        return reply.code(503).send({ error: "ERP filter source is unavailable" });
      }
    });

    scope.post("/api/reports/item-performance", async (request, reply) => {
      const denied = checkRouteAccess(request);
      if (denied) return reply.code(denied.statusCode).send({ error: denied.error });
      reply.header("Cache-Control", "no-store");

      const parsedBody = itemPerformanceRequestSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ error: "Invalid report query parameters" });
      }

      let snapshot: InventorySnapshot;
      try {
        snapshot = await resolveInventorySnapshot(parsedBody.data.to, request);
      } catch (err) {
        const message = err instanceof Error && err.message.includes("not configured")
          ? err.message
          : (sqlConfigFile ? "ERP SQL inventory source is unavailable" : "ERP inventory source is unavailable");
        request.log.error(err, "Failed to load inventory snapshot");
        return reply.code(503).send({ error: message });
      }

      try {
        return reply.send(computeItemPerformance(snapshot, parsedBody.data));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to compute report";
        return reply.code(400).send({ error: message });
      }
    });

    scope.post("/api/reports/item-ledger", async (request, reply) => {
      const denied = checkRouteAccess(request);
      if (denied) return reply.code(denied.statusCode).send({ error: denied.error });
      reply.header("Cache-Control", "no-store");

      const parsedBody = itemLedgerRequestSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ error: "Invalid item ledger query parameters" });
      }

      let snapshot: InventorySnapshot;
      try {
        snapshot = await resolveInventorySnapshot(parsedBody.data.to, request);
      } catch (err) {
        request.log.error(err, "Failed to load inventory snapshot for ledger");
        return reply.code(503).send({ error: "ERP inventory source is unavailable" });
      }

      try {
        return reply.send(computeItemLedger(snapshot, parsedBody.data));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to compute item ledger";
        return reply.code(400).send({ error: message });
      }
    });

    await scope.register(staticFiles, { root: directory, prefix: "/reports/", index: false, decorateReply: false });
    scope.get("/reports", async (_request, reply) => reply.redirect("/reports/"));
    const sendReportsHtml = async (_request: FastifyRequest, reply: any) =>
      reply.type("text/html; charset=utf-8").send(await readFile(resolve(directory, "index.html"), "utf8"));
    scope.get("/reports/", sendReportsHtml);
    scope.get("/reports/transfers", sendReportsHtml);
    scope.get("/reports/transfers/", sendReportsHtml);
  });
}
