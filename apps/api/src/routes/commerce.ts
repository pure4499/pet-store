import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withOrgScope } from "../db/pool.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { loadPetAvatarUrls, petAvatarKey } from "../lib/petAvatar.js";

export const commerceRouter = Router();
commerceRouter.use(requireAuth, requireRole("owner_admin", "manager"));

const catalogItemSchema = z.object({
  itemType: z.enum(["service", "product"]),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  sku: z.string().trim().max(80).optional(),
  unitPriceCents: z.number().int().min(0).max(10_000_000),
  taxable: z.boolean().default(false),
  trackInventory: z.boolean().default(false),
});

const updateCatalogItemSchema = catalogItemSchema.extend({
  isActive: z.boolean(),
});

commerceRouter.get(
  "/commerce/catalog-items",
  asyncRoute(async (req, res) => {
    const includeInactive = req.query.includeInactive === "true";
    const items = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT id, item_type, name, description, sku, unit_price_cents, currency,
                taxable, track_inventory, is_active, created_at, updated_at
         FROM commerce_catalog_items
         WHERE organization_id = $1 AND ($2::boolean OR is_active)
         ORDER BY item_type, lower(name)`,
        [req.auth!.organizationId, includeInactive]
      );
      const avatarUrls = await loadPetAvatarUrls(client, req.auth!.organizationId, result.rows.map((row) => ({ petId: row.pet_id, sessionId: row.session_id })));
      return result.rows.map((row) => ({ ...row, photo_thumbnail_url: avatarUrls.get(petAvatarKey(row.pet_id, row.session_id)) ?? null }));
    });
    res.json(items);
  })
);

commerceRouter.post(
  "/commerce/catalog-items",
  asyncRoute(async (req, res) => {
    const body = catalogItemSchema.parse(req.body);
    try {
      const item = await withOrgScope(req.auth!.organizationId, async (client) => {
        const result = await client.query(
          `INSERT INTO commerce_catalog_items
             (organization_id, item_type, name, description, sku, unit_price_cents,
              taxable, track_inventory, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [
            req.auth!.organizationId,
            body.itemType,
            body.name,
            body.description || null,
            body.sku || null,
            body.unitPriceCents,
            body.taxable,
            body.trackInventory,
            req.auth!.sub,
          ]
        );
        return result.rows[0];
      });
      res.status(201).json(item);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new HttpError(409, "An active catalog item with that name or SKU already exists");
      }
      throw error;
    }
  })
);

commerceRouter.patch(
  "/commerce/catalog-items/:itemId",
  asyncRoute(async (req, res) => {
    const itemId = z.string().uuid().parse(req.params.itemId);
    const body = updateCatalogItemSchema.parse(req.body);
    try {
      const item = await withOrgScope(req.auth!.organizationId, async (client) => {
        const result = await client.query(
          `UPDATE commerce_catalog_items
           SET item_type = $1, name = $2, description = $3, sku = $4,
               unit_price_cents = $5, taxable = $6, track_inventory = $7,
               is_active = $8, updated_at = now()
           WHERE id = $9 AND organization_id = $10
           RETURNING id, item_type, name, description, sku, unit_price_cents,
                     currency, taxable, track_inventory, is_active, created_at, updated_at`,
          [
            body.itemType,
            body.name,
            body.description || null,
            body.sku || null,
            body.unitPriceCents,
            body.taxable,
            body.trackInventory,
            body.isActive,
            itemId,
            req.auth!.organizationId,
          ]
        );
        if (!result.rows[0]) throw new HttpError(404, "Catalog item not found");
        return result.rows[0];
      });
      res.json(item);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new HttpError(409, "An active catalog item with that name or SKU already exists");
      }
      throw error;
    }
  })
);

commerceRouter.get(
  "/commerce/overview",
  asyncRoute(async (req, res) => {
    const stays = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT sessions.id AS session_id, sessions.pet_id, pets.name AS pet_name,
                sessions.session_type, sessions.status, sessions.check_in_at,
                sessions.scheduled_check_in_at, sessions.expected_check_out_at,
                sheets.id AS charge_sheet_id, COALESCE(sheets.status, 'open') AS charge_status,
                COALESCE(sheets.currency, 'USD') AS currency,
                COALESCE(totals.item_count, 0)::int AS item_count,
                COALESCE(totals.total_cents, 0)::int AS total_cents
         FROM sessions
         JOIN pets ON pets.id = sessions.pet_id
          AND pets.organization_id = sessions.organization_id
         LEFT JOIN stay_charge_sheets sheets
           ON sheets.session_id = sessions.id
          AND sheets.organization_id = sessions.organization_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS item_count,
                  COALESCE(SUM(items.unit_price_cents * items.quantity - items.discount_cents + items.tax_cents), 0)::int AS total_cents
           FROM stay_charge_sheet_items items
           WHERE items.organization_id = sessions.organization_id
             AND items.charge_sheet_id = sheets.id
         ) totals ON true
         WHERE sessions.organization_id = $1
           AND sessions.status IN ('reserved', 'active')
         ORDER BY CASE sessions.status WHEN 'active' THEN 0 ELSE 1 END,
                  COALESCE(sessions.check_in_at, sessions.scheduled_check_in_at),
                  lower(pets.name)`,
        [req.auth!.organizationId]
      );
      return result.rows;
    });
    res.json({
      stats: {
        current_stays: stays.length,
        charged_stays: stays.filter((stay) => Number(stay.item_count) > 0).length,
        open_total_cents: stays.reduce((sum, stay) => sum + Number(stay.total_cents), 0),
      },
      stays,
      payment_status: "not_connected",
    });
  })
);

const addChargeItemSchema = z.object({
  catalogItemId: z.string().uuid().optional(),
  itemType: z.enum(["service", "product"]).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  unitPriceCents: z.number().int().min(0).max(10_000_000).optional(),
  quantity: z.number().int().min(1).max(999).default(1),
  notes: z.string().trim().max(500).optional(),
}).superRefine((body, context) => {
  if (!body.catalogItemId && (!body.name || body.unitPriceCents === undefined || !body.itemType)) {
    context.addIssue({
      code: "custom",
      message: "Choose a catalog item or provide a name, type, and price",
    });
  }
});

const updateChargeItemSchema = z.object({
  quantity: z.number().int().min(1).max(999),
  notes: z.string().trim().max(500).nullable().optional(),
});

commerceRouter.get(
  "/sessions/:sessionId/charge-sheet",
  asyncRoute(async (req, res) => {
    const result = await withOrgScope(req.auth!.organizationId, async (client) => {
      const session = await findSession(client, req.auth!.organizationId, req.params.sessionId);
      return loadChargeSheet(client, req.auth!.organizationId, session.id, session.pet_id);
    });
    res.json(result);
  })
);

commerceRouter.post(
  "/sessions/:sessionId/charge-sheet/items",
  asyncRoute(async (req, res) => {
    const body = addChargeItemSchema.parse(req.body);
    const sheet = await withOrgScope(req.auth!.organizationId, async (client) => {
      const session = await findSession(client, req.auth!.organizationId, req.params.sessionId);
      const chargeSheet = await ensureOpenChargeSheet(
        client,
        req.auth!.organizationId,
        session.id,
        session.pet_id,
        req.auth!.sub
      );

      let itemType = body.itemType!;
      let name = body.name!;
      let unitPriceCents = body.unitPriceCents!;
      if (body.catalogItemId) {
        const catalog = await client.query(
          `SELECT id, item_type, name, unit_price_cents, currency
           FROM commerce_catalog_items
           WHERE id = $1 AND organization_id = $2 AND is_active`,
          [body.catalogItemId, req.auth!.organizationId]
        );
        if (!catalog.rows[0]) throw new HttpError(404, "Catalog item not found");
        if (catalog.rows[0].currency !== chargeSheet.currency) {
          throw new HttpError(400, "Catalog item currency does not match this charge sheet");
        }
        itemType = catalog.rows[0].item_type;
        name = catalog.rows[0].name;
        unitPriceCents = catalog.rows[0].unit_price_cents;
      }

      const inserted = await client.query(
        `INSERT INTO stay_charge_sheet_items
           (organization_id, charge_sheet_id, catalog_item_id, item_type, name,
            unit_price_cents, quantity, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          req.auth!.organizationId,
          chargeSheet.id,
          body.catalogItemId ?? null,
          itemType,
          name,
          unitPriceCents,
          body.quantity,
          body.notes || null,
          req.auth!.sub,
        ]
      );
      await recordCommerceEvent(client, req.auth!.organizationId, chargeSheet.id, req.auth!.sub, "item_added", {
        itemId: inserted.rows[0].id,
        catalogItemId: body.catalogItemId ?? null,
        name,
        unitPriceCents,
        quantity: body.quantity,
      });
      return loadChargeSheet(client, req.auth!.organizationId, session.id, session.pet_id);
    });
    res.status(201).json(sheet);
  })
);

commerceRouter.patch(
  "/sessions/:sessionId/charge-sheet/items/:itemId",
  asyncRoute(async (req, res) => {
    const body = updateChargeItemSchema.parse(req.body);
    const sheet = await withOrgScope(req.auth!.organizationId, async (client) => {
      const session = await findSession(client, req.auth!.organizationId, req.params.sessionId);
      const updated = await client.query(
        `UPDATE stay_charge_sheet_items item
         SET quantity = $1, notes = $2, updated_at = now()
         FROM stay_charge_sheets sheet
         WHERE item.id = $3 AND item.organization_id = $4
           AND sheet.id = item.charge_sheet_id AND sheet.organization_id = item.organization_id
           AND sheet.session_id = $5 AND sheet.status = 'open'
         RETURNING item.id, item.charge_sheet_id`,
        [body.quantity, body.notes ?? null, req.params.itemId, req.auth!.organizationId, session.id]
      );
      if (!updated.rows[0]) throw new HttpError(404, "Open charge item not found");
      await recordCommerceEvent(client, req.auth!.organizationId, updated.rows[0].charge_sheet_id, req.auth!.sub, "item_updated", {
        itemId: updated.rows[0].id,
        quantity: body.quantity,
      });
      return loadChargeSheet(client, req.auth!.organizationId, session.id, session.pet_id);
    });
    res.json(sheet);
  })
);

commerceRouter.delete(
  "/sessions/:sessionId/charge-sheet/items/:itemId",
  asyncRoute(async (req, res) => {
    const sheet = await withOrgScope(req.auth!.organizationId, async (client) => {
      const session = await findSession(client, req.auth!.organizationId, req.params.sessionId);
      const deleted = await client.query(
        `DELETE FROM stay_charge_sheet_items item
         USING stay_charge_sheets sheet
         WHERE item.id = $1 AND item.organization_id = $2
           AND sheet.id = item.charge_sheet_id AND sheet.organization_id = item.organization_id
           AND sheet.session_id = $3 AND sheet.status = 'open'
         RETURNING item.id, item.charge_sheet_id, item.name`,
        [req.params.itemId, req.auth!.organizationId, session.id]
      );
      if (!deleted.rows[0]) throw new HttpError(404, "Open charge item not found");
      await recordCommerceEvent(client, req.auth!.organizationId, deleted.rows[0].charge_sheet_id, req.auth!.sub, "item_removed", {
        itemId: deleted.rows[0].id,
        name: deleted.rows[0].name,
      });
      return loadChargeSheet(client, req.auth!.organizationId, session.id, session.pet_id);
    });
    res.json(sheet);
  })
);

async function findSession(client: PoolClient, organizationId: string, sessionId: string) {
  const validSessionId = z.string().uuid().parse(sessionId);
  const result = await client.query(
    `SELECT id, pet_id, status FROM sessions WHERE id = $1 AND organization_id = $2`,
    [validSessionId, organizationId]
  );
  if (!result.rows[0]) throw new HttpError(404, "Session not found");
  if (result.rows[0].status === "cancelled") throw new HttpError(409, "Cancelled stays cannot have charges");
  return result.rows[0] as { id: string; pet_id: string; status: string };
}

async function ensureOpenChargeSheet(
  client: PoolClient,
  organizationId: string,
  sessionId: string,
  petId: string,
  actorUserId: string
) {
  await client.query(
    `INSERT INTO stay_charge_sheets (organization_id, session_id, pet_id, created_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (organization_id, session_id) DO NOTHING`,
    [organizationId, sessionId, petId, actorUserId]
  );
  const result = await client.query(
    `SELECT id, status, currency FROM stay_charge_sheets
     WHERE organization_id = $1 AND session_id = $2 FOR UPDATE`,
    [organizationId, sessionId]
  );
  if (result.rows[0]?.status !== "open") throw new HttpError(409, "This charge sheet is no longer editable");
  return result.rows[0] as { id: string; status: string; currency: string };
}

async function loadChargeSheet(client: PoolClient, organizationId: string, sessionId: string, petId: string) {
  const sheetResult = await client.query(
    `SELECT id, session_id, pet_id, status, currency, notes, created_at, updated_at
     FROM stay_charge_sheets WHERE organization_id = $1 AND session_id = $2`,
    [organizationId, sessionId]
  );
  const sheet = sheetResult.rows[0];
  if (!sheet) {
    return {
      id: null,
      session_id: sessionId,
      pet_id: petId,
      status: "open",
      currency: "USD",
      notes: null,
      items: [],
      subtotal_cents: 0,
      discount_cents: 0,
      tax_cents: 0,
      total_cents: 0,
      payment_status: "not_connected",
    };
  }

  const itemResult = await client.query(
    `SELECT id, catalog_item_id, item_type, name, unit_price_cents, quantity,
            discount_cents, tax_cents, notes, created_at, updated_at,
            (unit_price_cents * quantity - discount_cents + tax_cents)::int AS line_total_cents
     FROM stay_charge_sheet_items
     WHERE organization_id = $1 AND charge_sheet_id = $2
     ORDER BY created_at, id`,
    [organizationId, sheet.id]
  );
  const items = itemResult.rows;
  const subtotal = items.reduce((sum, item) => sum + Number(item.unit_price_cents) * Number(item.quantity), 0);
  const discounts = items.reduce((sum, item) => sum + Number(item.discount_cents), 0);
  const taxes = items.reduce((sum, item) => sum + Number(item.tax_cents), 0);
  return {
    ...sheet,
    items,
    subtotal_cents: subtotal,
    discount_cents: discounts,
    tax_cents: taxes,
    total_cents: subtotal - discounts + taxes,
    payment_status: "not_connected",
  };
}

async function recordCommerceEvent(
  client: PoolClient,
  organizationId: string,
  chargeSheetId: string,
  actorUserId: string,
  eventType: string,
  eventData: Record<string, unknown>
) {
  await client.query(
    `INSERT INTO commerce_events
       (organization_id, charge_sheet_id, event_type, actor_user_id, event_data)
     VALUES ($1,$2,$3,$4,$5)`,
    [organizationId, chargeSheetId, eventType, actorUserId, JSON.stringify(eventData)]
  );
  await client.query(
    `UPDATE stay_charge_sheets SET updated_at = now()
     WHERE id = $1 AND organization_id = $2`,
    [chargeSheetId, organizationId]
  );
}
