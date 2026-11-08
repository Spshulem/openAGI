import { randomUUID } from "node:crypto";

export const MAX_MESSAGE_IMAGES = 4;
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_IMAGE_MESSAGE_BODY = 5 * 1024 * 1024;

// Inline pixels only: a phone cannot make main fetch a URL or read a file.
// Thumbnails are separately bounded so history never returns the originals.
export function normalizeMessageImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_IMAGES) throw new Error("Attach up to four images.");
  let total = 0;
  const ids = new Set();
  return value.map(image => {
    if (!image || typeof image !== "object" || Array.isArray(image)
        || Object.keys(image).some(key => !["id", "name", "mimeType", "data", "thumbnail"].includes(key))) {
      throw new Error("Image attachments must contain inline image data.");
    }
    const id = image.id ?? randomUUID();
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || ids.has(id)) throw new Error("Each image needs a distinct valid id.");
    ids.add(id);
    if (!["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)) throw new Error("Use JPEG, PNG or WebP images.");
    const data = imageBytes(image.data, image.mimeType, MAX_IMAGE_BYTES);
    total += data.length;
    if (total > MAX_MESSAGE_IMAGE_BYTES) throw new Error("Images must total no more than 3 MB.");
    if (image.name !== undefined && (typeof image.name !== "string" || image.name.length > 120 || /[\x00-\x1f]/.test(image.name))) throw new Error("Use a short image filename.");
    if (image.thumbnail !== undefined) imageBytes(image.thumbnail, "image/jpeg", 24 * 1024);
    return { id, name: image.name || "Image", mimeType: image.mimeType, data: image.data,
      ...(image.thumbnail ? { thumbnail: image.thumbnail } : {}) };
  });
}

function imageBytes(encoded, mimeType, limit) {
  if (typeof encoded !== "string" || !encoded.length || encoded.length > Math.ceil(limit / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("Image data is invalid or too large.");
  const bytes = Buffer.from(encoded, "base64");
  const valid = mimeType === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    : mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid || bytes.length > limit || bytes.toString("base64") !== encoded) throw new Error("Image data does not match its format.");
  return bytes;
}

export function imageContent(text, images = [], format = "openai") {
  if (!images.length) return text;
  const content = [{ type: format === "openai" ? "input_text" : "text", text: String(text || "Describe these images.") }];
  for (const image of images) {
    if (format === "anthropic") content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
    else if (format === "chat") content.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
    else content.push({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` });
  }
  return content;
}

export function imageHistory(messages, input, images) {
  // AgentHost's history already includes this user turn. Attach its pixels
  // to the current anchor exactly once, including on every tool-loop hop.
  const last = messages.at(-1);
  return (images.length && last?.role === "user" && last.content === input ? messages.slice(0, -1) : messages).slice(-12);
}

export function imageHistoryPreview(images) {
  return (images ?? []).map(({ id, name, thumbnail }) => ({ id, name, mimeType: "image/jpeg", ...(thumbnail ? { thumbnail } : {}) }));
}

export function unsupportedImageInput() {
  const error = new Error("This model cannot view images. Choose a vision-capable model in Model settings, then send the images again.");
  error.code = "IMAGE_INPUT_UNSUPPORTED";
  return error;
}
