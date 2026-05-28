import 'dotenv/config'

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value == null || value === '') {
    throw new Error(`Variável de ambiente ${name} não definida`)
  }
  return value
}

export const env = {
  port: Number(process.env.PORT ?? 3030),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  authUsername: required('AUTH_USERNAME'),
  authPassword: required('AUTH_PASSWORD'),
  dataDir: process.env.DATA_DIR ?? './data',
  sessionSecret: required('SESSION_SECRET'),
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
  /** Opcional. Se definida, requests com Authorization: Bearer <key> ou X-API-Key: <key> autenticam. */
  apiKey: process.env.API_KEY ?? '',
}

export const isProd = env.nodeEnv === 'production'
