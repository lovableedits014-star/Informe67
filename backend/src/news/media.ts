import sharp from "sharp";
import { mkdir, writeFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mediaUrl, NewsError } from "./validation.js";

export const uploadDirectory = resolve(process.env.NEWS_UPLOAD_DIR ?? fileURLToPath(new URL("../../uploads/news/", import.meta.url)));
export async function processImage(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > 5 * 1024 * 1024) throw new NewsError(413, "A imagem deve ter até 5 MB.");
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) throw Error();
    return await image.rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  } catch { throw new NewsError(400, "Envie uma imagem JPEG, PNG ou WebP válida, sem animação e com até 40 megapixels."); }
}
export async function saveImage(bytes: Buffer) {
  const image = await processImage(bytes);
  const name = `${randomUUID()}.webp`;
  await mkdir(uploadDirectory, { recursive: true });
  await writeFile(resolve(uploadDirectory, name), image, { flag: "wx" });
  return { imageUrl: `/media/news/${name}` };
}
export async function assertImagesExist(urls: string[]) {
  for (const url of urls) {
    if (!mediaUrl.test(url)) throw new NewsError(400, "Imagem inválida.");
    try { await access(resolve(uploadDirectory, url.split("/").at(-1)!)); }
    catch { throw new NewsError(400, "Imagem não encontrada. Envie novamente."); }
  }
}
