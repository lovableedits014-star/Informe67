export type DatabaseDiagnostic = {
  code: string;
  message: string;
};

const knownErrorMessages: Record<string, string> = {
  ECONNREFUSED:
    "Conexão recusada pelo destino PostgreSQL. Verifique o túnel SSH, o host e a porta.",
  ETIMEDOUT:
    "Tempo limite de conexão excedido. Verifique o túnel SSH e a rota até o PostgreSQL.",
  "28P01":
    "Autenticação PostgreSQL falhou. Verifique PGUSER e PGPASSWORD.",
  "28000":
    "PostgreSQL rejeitou a política de conexão. Verifique pg_hba.conf e requisitos de SSL.",
  "3D000":
    "O banco especificado não existe ou não está visível para o usuário. Verifique PGDATABASE.",
};

function redactMessage(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[URL de conexão redigida]")
    .replace(
      /\b(password|passwd|pwd)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redigido]",
    )
    .replace(
      /\b(user|database|host)\s+("[^"]*"|'[^']*')/gi,
      "$1 [redigido]",
    )
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 300);
}

export function databaseDiagnostic(error: unknown): DatabaseDiagnostic {
  const errorRecord =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown })
      : {};
  const code =
    typeof errorRecord.code === "string" &&
    /^[A-Z0-9_]{1,32}$/.test(errorRecord.code)
      ? errorRecord.code
      : "UNKNOWN";
  const originalMessage =
    typeof errorRecord.message === "string"
      ? errorRecord.message
      : "Mensagem técnica indisponível.";

  return {
    code,
    message:
      knownErrorMessages[code] ??
      redactMessage(originalMessage) ??
      "Falha de conexão com o banco.",
  };
}
