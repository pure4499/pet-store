import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  migrateDatabaseUrl: process.env.MIGRATE_DATABASE_URL ?? required("DATABASE_URL"),
  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET"),
    refreshSecret: required("JWT_REFRESH_SECRET"),
    accessTtl: "15m" as const,
    refreshTtl: "30d" as const,
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: process.env.S3_BUCKET ?? "pet-hotel-photos-dev",
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  },
  email: {
    // Deliberately not required() — the API should still start without this
    // configured; only actually sending a report should fail, and clearly.
    sendGridApiKey: process.env.SENDGRID_API_KEY,
    resendApiKey: process.env.RESEND_API_KEY,
    fromAddress: process.env.REPORTS_FROM_EMAIL ?? "onboarding@resend.dev",
    fromName: process.env.REPORTS_FROM_NAME?.trim() || "UCBarkley",
    // When set, all report-share messages are routed only to this address.
    // This staging/beta guardrail must never be hard-coded.
    testRecipient: process.env.REPORTS_TEST_RECIPIENT?.trim().toLowerCase() || undefined,
  },
  publicReportBaseUrl: (process.env.PUBLIC_REPORT_BASE_URL ?? "http://localhost:3000/public/reports").replace(/\/$/, ""),
};
