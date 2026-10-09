import { Resend } from "resend";
import { config } from "../config.js";
import { presignGetUrl } from "./s3.js";

// Long enough that a photo embedded in an email still renders whenever the
// owner actually opens it (could be days later) — 7 days is S3's presigned
// URL maximum under SigV4.
const EMAIL_IMAGE_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export function isEmailDeliveryConfigured(): boolean {
  return Boolean(config.email.sendGridApiKey || config.email.resendApiKey);
}

export async function sendEmail(input: { to: string[]; subject: string; html: string }): Promise<void> {
  if (config.email.sendGridApiKey) {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.email.sendGridApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: input.to.map((email) => ({ email })) }],
        from: { email: config.email.fromAddress, name: config.email.fromName },
        subject: input.subject,
        content: [{ type: "text/html", value: input.html }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(`SendGrid could not send this email (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    return;
  }

  if (!config.email.resendApiKey) {
    throw new Error("Email delivery is not configured. Add SENDGRID_API_KEY or RESEND_API_KEY.");
  }
  const resend = new Resend(config.email.resendApiKey);
  const { error } = await resend.emails.send({
    from: config.email.fromAddress,
    to: input.to,
    subject: input.subject,
    html: input.html,
  });
  if (error) {
    throw new Error(`Resend failed to send: ${error.message}`);
  }
}

export interface ReportPet {
  name: string;
  species: string;
  logEntries: { entryType: string; entryAt: string; title: string | null; body: string | null }[];
  photoStorageKeys: string[];
}

export async function renderDailyReportHtml(input: {
  organizationName: string;
  date: string;
  pets: ReportPet[];
}): Promise<string> {
  const petSections = await Promise.all(
    input.pets.map(async (pet) => {
      const logHtml = pet.logEntries
        .map(
          (entry) =>
            `<li><strong>${escapeHtml(entry.entryType)}</strong>${entry.body ? `: ${escapeHtml(entry.body)}` : ""}</li>`
        )
        .join("");
      const photoUrls = await Promise.all(
        pet.photoStorageKeys.map((key) => presignGetUrl(key, EMAIL_IMAGE_URL_TTL_SECONDS))
      );
      const photosHtml = photoUrls
        .map((url) => `<img src="${url}" width="150" style="border-radius:8px;margin:4px" />`)
        .join("");
      return `
        <h2>${escapeHtml(pet.name)} (${escapeHtml(pet.species)})</h2>
        ${logHtml ? `<ul>${logHtml}</ul>` : "<p>No log entries today.</p>"}
        ${photosHtml ? `<div>${photosHtml}</div>` : ""}
      `;
    })
  );

  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h1>${escapeHtml(input.organizationName)} — ${escapeHtml(input.date)}</h1>
      ${petSections.join("<hr/>")}
      <p style="color:#888; font-size:12px;">Sent from ${escapeHtml(input.organizationName)} via UCBarkley.</p>
    </div>
  `;
}

export function renderReportShareEmailHtml(input: {
  ownerName: string;
  petName: string;
  organizationName: string;
  reportDate: string;
  shareUrl: string;
}): string {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:28px;color:#173f38">
      <p style="margin:0 0 8px;color:#177462;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">${escapeHtml(input.organizationName)}</p>
      <h1 style="margin:0 0 14px;font-size:28px">${escapeHtml(input.petName)}’s report is ready</h1>
      <p style="margin:0 0 20px;color:#5f746e;line-height:1.6">Hi ${escapeHtml(input.ownerName)}, open the private share link below to see ${escapeHtml(input.petName)}’s report for ${escapeHtml(input.reportDate)}. You may share the same link with family.</p>
      <a href="${escapeHtml(input.shareUrl)}" style="display:inline-block;padding:14px 20px;border-radius:12px;background:#177462;color:#fff;text-decoration:none;font-weight:700">View ${escapeHtml(input.petName)}’s report</a>
      <p style="margin:24px 0 0;color:#81908c;font-size:12px;line-height:1.5">This email does not contain report photos or video. Anyone with the link can view the report, so please share it only with people you trust.</p>
    </div>
  `;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
