import { loadBackendEnvironment } from "./config/environment.js";
import { buildApp } from "./app.js";

const environment = loadBackendEnvironment(import.meta.url);
console.info(
  `[diagnostico local] Configuração carregada de ${environment.source}; ` +
    `PGHOST=${process.env.PGHOST ?? "(não definido)"} ` +
    `PGPORT=${process.env.PGPORT ?? "5432"} ` +
    `PGDATABASE=${process.env.PGDATABASE ?? "(não definido)"}; ` +
    `PGUSER=${process.env.PGUSER ? "configurado" : "não configurado"}; ` +
    `PGPASSWORD=${process.env.PGPASSWORD ? "configurada" : "não configurada"}.`,
);

const app = buildApp(undefined, { newsScheduler: true });
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT deve ser um número inteiro entre 1 e 65535.");
}

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
