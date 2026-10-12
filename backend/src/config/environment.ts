import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type EnvironmentLoadResult = {
  source: "backend/.env" | "process environment";
  filePath: string;
};

export function backendEnvPath(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../.env");
}

export function loadBackendEnvironment(
  moduleUrl: string,
): EnvironmentLoadResult {
  const filePath = backendEnvPath(moduleUrl);
  const result = config({ path: filePath });

  if (result.error && result.error.code !== "ENOENT") {
    throw new Error("Não foi possível carregar backend/.env.");
  }

  return {
    source: result.parsed ? "backend/.env" : "process environment",
    filePath,
  };
}
