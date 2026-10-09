import type { PoolClient } from "pg";
import { Router } from "express";
import { z } from "zod";
import { withOrgScope } from "../db/pool.js";
import { renderDailyReportHtml, sendEmail, type ReportPet } from "../lib/email.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const householdsRouter = Router();
householdsRouter.use(requireAuth);

/** Shared by the link-household response and GET /pets/:id's `household` field. */
export async function getHouseholdDetail(client: PoolClient, householdId: string) {
  const result = await client.query(
    `SELECT o.id AS owner_id, o.full_name, o.phone,
            COALESCE(
              json_agg(json_build_object('id', p.id, 'name', p.name, 'species', p.species))
                FILTER (WHERE p.id IS NOT NULL),
              '[]'
            ) AS pets
     FROM owners o
     LEFT JOIN pets p ON p.owner_id = o.id
     WHERE o.household_id = $1
     GROUP BY o.id, o.full_name, o.phone
     ORDER BY o.full_name`,
    [householdId]
  );
  return {
    id: householdId,
    members: result.rows.map((row) => ({
      ownerId: row.owner_id,
      ownerName: row.full_name,
      phone: row.phone,
      pets: row.pets,
    })),
  };
}

const linkSchema = z.object({ otherOwnerId: z.string().uuid() });

// Staff-facing action is "these two are the same family" — the household row
// itself is an implementation detail, created the first time two owners are
// linked (see plan: no standalone POST /households).
householdsRouter.post(
  "/owners/:id/link-household",
  asyncRoute(async (req, res) => {
    const body = linkSchema.parse(req.body);
    if (body.otherOwnerId === req.params.id) {
      throw new HttpError(400, "Cannot link an owner to themselves");
    }

    const household = await withOrgScope(req.auth!.organizationId, async (client) => {
      const ownersResult = await client.query(
        `SELECT id, household_id FROM owners WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
        [[req.params.id, body.otherOwnerId], req.auth!.organizationId]
      );
      if (ownersResult.rows.length !== 2) {
        throw new HttpError(404, "One or both owners not found");
      }
      const thisOwner = ownersResult.rows.find((r) => r.id === req.params.id)!;
      const otherOwner = ownersResult.rows.find((r) => r.id === body.otherOwnerId)!;

      let householdId: string;
      if (thisOwner.household_id && otherOwner.household_id) {
        if (thisOwner.household_id !== otherOwner.household_id) {
          throw new HttpError(409, "Both owners are already in different households — merging isn't supported yet");
        }
        householdId = thisOwner.household_id;
      } else if (thisOwner.household_id) {
        householdId = thisOwner.household_id;
        await client.query(`UPDATE owners SET household_id = $1 WHERE id = $2`, [householdId, otherOwner.id]);
      } else if (otherOwner.household_id) {
        householdId = otherOwner.household_id;
        await client.query(`UPDATE owners SET household_id = $1 WHERE id = $2`, [householdId, thisOwner.id]);
      } else {
        const createResult = await client.query(
          `INSERT INTO households (organization_id) VALUES ($1) RETURNING id`,
          [req.auth!.organizationId]
        );
        householdId = createResult.rows[0].id;
        await client.query(`UPDATE owners SET household_id = $1 WHERE id = ANY($2::uuid[])`, [
          householdId,
          [thisOwner.id, otherOwner.id],
        ]);
      }

      return getHouseholdDetail(client, householdId);
    });

    res.status(201).json(household);
  })
);

householdsRouter.post(
  "/owners/:id/unlink-household",
  asyncRoute(async (req, res) => {
    const owner = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `UPDATE owners SET household_id = NULL WHERE id = $1 AND organization_id = $2 RETURNING id`,
        [req.params.id, req.auth!.organizationId]
      );
      return result.rows[0];
    });
    if (!owner) throw new HttpError(404, "Owner not found");
    res.status(204).send();
  })
);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sendReportSchema = z.object({ date: dateSchema.optional() });

householdsRouter.post(
  "/households/:id/send-report",
  asyncRoute(async (req, res) => {
    const body = sendReportSchema.parse(req.body);
    const reportDate = body.date ?? new Date().toISOString().slice(0, 10);

    const result = await withOrgScope(req.auth!.organizationId, async (client) => {
      const household = await getHouseholdDetail(client, req.params.id);
      if (household.members.length === 0) {
        throw new HttpError(404, "Household not found");
      }

      const orgResult = await client.query(`SELECT name FROM organizations WHERE id = $1`, [
        req.auth!.organizationId,
      ]);
      const organizationName = orgResult.rows[0].name;

      const reportPets: ReportPet[] = [];
      const petIds: string[] = [];
      for (const member of household.members) {
        for (const pet of member.pets as { id: string; name: string; species: string }[]) {
          const sessionsResult = await client.query(
            `SELECT id FROM sessions
             WHERE pet_id = $1 AND status <> 'cancelled'
               AND check_in_at::date <= $2::date
               AND (check_out_at IS NULL OR check_out_at::date >= $2::date)`,
            [pet.id, reportDate]
          );
          const sessionIds: string[] = sessionsResult.rows.map((r) => r.id);
          if (sessionIds.length === 0) continue;

          const logsResult = await client.query(
            `SELECT entry_type, entry_at, title, body FROM daily_log_entries
             WHERE session_id = ANY($1::uuid[]) AND entry_at::date = $2::date
             ORDER BY entry_at`,
            [sessionIds, reportDate]
          );
          const photosResult = await client.query(
            `SELECT p.storage_key FROM photo_pet_links l JOIN photos p
               ON p.id = l.photo_id AND p.organization_id = l.organization_id AND p.deleted_at IS NULL
             WHERE l.session_id = ANY($1::uuid[]) AND l.review_state = 'published' AND l.published_at::date = $2::date`,
            [sessionIds, reportDate]
          );

          if (logsResult.rows.length === 0 && photosResult.rows.length === 0) continue;

          petIds.push(pet.id);
          reportPets.push({
            name: pet.name,
            species: pet.species,
            logEntries: logsResult.rows.map((r) => ({
              entryType: r.entry_type,
              entryAt: r.entry_at,
              title: r.title,
              body: r.body,
            })),
            photoStorageKeys: photosResult.rows.map((r) => r.storage_key),
          });
        }
      }

      if (reportPets.length === 0) {
        throw new HttpError(400, `Nothing to report for ${reportDate}`);
      }

      // getHouseholdDetail doesn't select owner email, so fetch recipients directly here.
      const emailsResult = await client.query(
        `SELECT DISTINCT email FROM owners WHERE household_id = $1 AND email IS NOT NULL`,
        [req.params.id]
      );
      const recipients: string[] = emailsResult.rows.map((r) => r.email);
      if (recipients.length === 0) {
        throw new HttpError(400, "No email on file for this household");
      }

      const html = await renderDailyReportHtml({ organizationName, date: reportDate, pets: reportPets });
      await sendEmail({
        to: recipients,
        subject: `${organizationName} — update for ${reportDate}`,
        html,
      });

      await client.query(
        `INSERT INTO household_reports (organization_id, household_id, report_date, sent_by, recipient_emails, pet_ids)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.auth!.organizationId, req.params.id, reportDate, req.auth!.sub, recipients, petIds]
      );

      return { reportDate, recipients, petIds };
    });

    res.status(201).json(result);
  })
);

householdsRouter.get(
  "/households/:id/reports",
  asyncRoute(async (req, res) => {
    const rows = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT * FROM household_reports WHERE household_id = $1 AND organization_id = $2 ORDER BY report_date DESC`,
        [req.params.id, req.auth!.organizationId]
      );
      return result.rows;
    });
    res.json(rows);
  })
);
