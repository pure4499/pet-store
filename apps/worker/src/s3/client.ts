import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";

export const s3Client = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials:
    config.s3.accessKeyId && config.s3.secretAccessKey
      ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
      : undefined,
});

export async function downloadObject(key: string): Promise<Buffer> {
  const result = await s3Client.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function uploadObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: body, ContentType: contentType })
  );
}
