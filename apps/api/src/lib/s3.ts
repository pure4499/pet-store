import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";

// Points at MinIO in local dev (S3_ENDPOINT set); in AWS, endpoint is left
// unset and the SDK talks to real S3 in config.s3.region.
export const s3Client = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials:
    config.s3.accessKeyId && config.s3.secretAccessKey
      ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
      : undefined,
});

export async function presignPutUrl(key: string, contentType: string): Promise<string> {
  const command = new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, ContentType: contentType });
  return getSignedUrl(s3Client, command, { expiresIn: 15 * 60 });
}

export async function presignGetUrl(key: string, expiresInSeconds = 60 * 60): Promise<string> {
  const command = new GetObjectCommand({ Bucket: config.s3.bucket, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

export async function deleteObject(key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
}
