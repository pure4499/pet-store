import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { ImagePickerAsset } from "expo-image-picker";
import { PHOTO_JPEG_QUALITY, PHOTO_LONG_EDGE_PX } from "./mediaPolicy";

export interface PreparedPickedImage {
  uri: string;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  convertedFromHeic: boolean;
}

export function isHeicAsset(asset: ImagePickerAsset) {
  const mimeType = asset.mimeType?.toLowerCase() ?? "";
  return mimeType === "image/heic"
    || mimeType === "image/heif"
    || mimeType === "image/heic-sequence"
    || mimeType === "image/heif-sequence"
    || /\.(heic|heif)$/i.test(asset.fileName ?? "")
    || /\.(heic|heif)(?:\?|$)/i.test(asset.uri);
}

export async function preparePickedImage(asset: ImagePickerAsset, fallbackPrefix: string): Promise<PreparedPickedImage> {
  const context = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > PHOTO_LONG_EDGE_PX) {
    if (asset.width >= asset.height) context.resize({ width: PHOTO_LONG_EDGE_PX, height: null });
    else context.resize({ width: null, height: PHOTO_LONG_EDGE_PX });
  }
  const rendered = await context.renderAsync();
  const jpeg = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_JPEG_QUALITY });
  const originalName = asset.fileName ?? fallbackPrefix;
  const baseName = originalName.replace(/\.[^/.]+$/, "") || fallbackPrefix;

  return {
    uri: jpeg.uri,
    fileName: `${baseName}.jpg`,
    mimeType: "image/jpeg",
    width: jpeg.width,
    height: jpeg.height,
    convertedFromHeic: isHeicAsset(asset),
  };
}
