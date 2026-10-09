import { Router } from "express";
import { z } from "zod";
import { withOrgScope } from "../db/pool.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const logsRouter = Router();
logsRouter.use(requireAuth);

logsRouter.get(
  "/sessions/:sessionId/logs",
  asyncRoute(async (req, res) => {
    const rows = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT log.*, users.full_name AS created_by_name
         FROM daily_log_entries log
         LEFT JOIN users ON users.id = log.created_by AND users.organization_id = log.organization_id
         WHERE log.session_id = $1 AND log.organization_id = $2
         ORDER BY log.entry_at DESC`,
        [req.params.sessionId, req.auth!.organizationId]
      );
      return result.rows;
    });
    res.json(rows);
  })
);

const createLogSchema = z.object({
  entryType: z.enum(["note", "feeding", "medication", "activity", "incident", "other"]),
  entryAt: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  structuredData: z.record(z.unknown()).optional(),
});

logsRouter.post(
  "/sessions/:sessionId/logs",
  asyncRoute(async (req, res) => {
    const body = createLogSchema.parse(req.body);
    const entry = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `INSERT INTO daily_log_entries
           (organization_id, session_id, entry_type, entry_at, created_by, title, body, structured_data)
         SELECT sessions.organization_id, sessions.id, $3, COALESCE($4, now()), $5, $6, $7, $8
         FROM sessions
         WHERE sessions.id = $2 AND sessions.organization_id = $1
         RETURNING *`,
        [
          req.auth!.organizationId,
          req.params.sessionId,
          body.entryType,
          body.entryAt,
          req.auth!.sub,
          body.title,
          body.body,
          body.structuredData ? JSON.stringify(body.structuredData) : null,
        ]
      );
      if (!result.rows[0]) throw new HttpError(404, "Session not found");
      return result.rows[0];
    });
    res.status(201).json(entry);
  })
);
