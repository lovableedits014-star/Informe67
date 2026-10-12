import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new Error("A senha deve ter pelo menos 12 caracteres e no máximo 1024 bytes.");
  }
  const salt = randomBytes(16).toString("hex");
  return `scrypt$32768$8$1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  // Invalid/absent hashes still incur the password derivation cost.
  const key = await derive(password, match?.[1] ?? "00000000000000000000000000000000");
  return !!match && timingSafeEqual(key, Buffer.from(match[2], "hex"));
}
