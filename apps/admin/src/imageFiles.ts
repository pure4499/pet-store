const HEIC_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

export const MAX_ADMIN_MEDIA_BATCH_ITEMS = 50;
export const MAX_PHOTO_LONG_EDGE_PX = 2048;
export const PHOTO_JPEG_QUALITY = 0.8;
export const MAX_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024;

export function isHeicFile(file: File) {
  return HEIC_MIME_TYPES.has(file.type.toLowerCase()) || /\.(heic|heif)$/i.test(file.name);
}

export function isImageFile(file: File) {
  return file.type.startsWith("image/") || isHeicFile(file);
}

export async function prepareImageFiles(
  selected: File[],
  onHeicProgress?: (completed: number, total: number) => void,
) {
  const heicTotal = selected.filter(isHeicFile).length;
  let heicCompleted = 0;
  const files: File[] = [];

  onHeicProgress?.(0, heicTotal);

  // Decode one photo at a time. HEIC decoding is memory intensive, especially
  // when a manager selects a large iPhone photo batch.
  for (const file of selected) {
    try {
      const source = isHeicFile(file) ? await convertHeicToJpeg(file) : file;
      const baseName = file.name.replace(/\.[^/.]+$/, "") || "photo";
      const optimized = await optimizeAsJpeg(source, `${baseName}.jpg`, file.lastModified);
      if (optimized.size > MAX_PHOTO_UPLOAD_BYTES) {
        throw new Error("The optimized photo is still larger than 10 MB.");
      }
      files.push(optimized);
      if (isHeicFile(file)) {
        heicCompleted += 1;
        onHeicProgress?.(heicCompleted, heicTotal);
      }
    } catch (error) {
      throw new Error(`Could not prepare ${file.name}. ${errorMessage(error)}`);
    }
  }

  return { files, convertedCount: heicCompleted };
}

function optimizeAsJpeg(source: Blob, fileName: string, lastModified: number): Promise<File> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, MAX_PHOTO_LONG_EDGE_PX / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas is unavailable."));
        return;
      }
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((jpeg) => {
        URL.revokeObjectURL(url);
        if (!jpeg) {
          reject(new Error("The browser could not create an optimized JPEG."));
          return;
        }
        resolve(new File([jpeg], fileName, { type: "image/jpeg", lastModified }));
      }, "image/jpeg", PHOTO_JPEG_QUALITY);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The browser could not decode this image."));
    };
    image.src = url;
  });
}

async function convertHeicToJpeg(file: File) {
  try {
    // heic-to follows current libheif releases, which supports newer iPhone
    // encodings that the older heic2any decoder cannot read.
    const { heicTo } = await import("heic-to");
    return await heicTo({ blob: file, type: "image/jpeg", quality: 0.9 });
  } catch (wasmError) {
    // Safari can decode HEIC natively. This also handles a JPEG whose filename
    // was incorrectly left as .HEIC by a file export.
    try {
      return await convertWithBrowserImageDecoder(file);
    } catch (browserError) {
      throw new Error(`${errorMessage(wasmError)} Browser fallback: ${errorMessage(browserError)}`);
    }
  }
}

function convertWithBrowserImageDecoder(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas is unavailable."));
        return;
      }
      context.drawImage(image, 0, 0);
      canvas.toBlob((jpeg) => {
        URL.revokeObjectURL(url);
        jpeg ? resolve(jpeg) : reject(new Error("The browser could not create a JPEG."));
      }, "image/jpeg", 0.9);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The browser could not decode this image."));
    };
    image.src = url;
  });
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // Ignore serialization failures and use the actionable fallback below.
  }
  return "This HEIC encoding is not readable.";
}
