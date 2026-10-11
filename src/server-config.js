export function getServerBinding(environment = process.env) {
  const configuredPort = environment.PORT?.trim();
  const port = configuredPort ? Number(configuredPort) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT deve ser um número inteiro entre 0 e 65535. Use 0 ou deixe vazio para uma porta dinâmica.');
  }

  // Do not force localhost or a specific interface when the host is managed by the platform.
  const host = environment.HOST?.trim() || undefined;
  return { host, port };
}
