import 'dotenv/config'

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value == null || value === '') {
    throw new Error(`Variável de ambiente ${name} não definida`)
  }
  return value
}

export type ShopeeRuntimeEnv = 'sandbox' | 'production'

function envTrim(name: string): string {
  return (process.env[name] ?? '').trim()
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
  /** Shopee Open Platform — Live API Partner Key (chamadas Open API). */
  shopeePartnerKey: envTrim('SHOPEE_PARTNER_KEY'),
  /**
   * Live Push Partner Key — assinatura HMAC dos webhooks (Push Mechanism).
   * Diferente da Live API Partner Key; copie em Push Mechanism no console Shopee.
   */
  shopeePushPartnerKey: envTrim('SHOPEE_PUSH_PARTNER_KEY'),
  /**
   * "Test Push Partner Key" — chave separada que o console Shopee usa só pra disparar o
   * push de teste (botão "Get Test Push"). Some/soma junto de shopeePushPartnerKey na
   * verificação de assinatura, sem substituir a chave de produção.
   */
  shopeePushTestPartnerKey: envTrim('SHOPEE_PUSH_TEST_PARTNER_KEY'),
  /**
   * URL exata cadastrada no console Shopee (Live Call Back URL).
   * Se vazio, monta a partir do request (protocol + host + path).
   */
  shopeePushCallbackUrl: envTrim('SHOPEE_PUSH_CALLBACK_URL'),
  /** Partner ID numérico do app na Shopee Open Platform */
  shopeePartnerId: envTrim('SHOPEE_PARTNER_ID'),
  /** sandbox | production */
  shopeeEnv: (process.env.SHOPEE_ENV === 'sandbox' ? 'sandbox' : 'production') as ShopeeRuntimeEnv,
  /** Redirect OAuth — ex. https://planilha.guilhermesales.com/api/shopee/oauth/callback */
  shopeeRedirectUrl: envTrim('SHOPEE_REDIRECT_URL'),
  /**
   * Cursor next_timestamp_nano para warm-cursor (pág. 285). Fallback em código: 1781192143549324413
   */
  shopeeLinkStartTimestampNano: envTrim('SHOPEE_LINK_START_TIMESTAMP_NANO'),
  /**
   * PicWish — remoção de fundo das fotos no picker web (modo recorte).
   * Sem fallback embutido de propósito: chave não entra em repositório.
   * Configurar no Dokploy (mesma chave usada por scripts/picwish.py no
   * pipeline local). Sem ela, só o modo coração funciona.
   */
  picwishApiKey: envTrim('PICWISH_API_KEY'),
}

export const isProd = env.nodeEnv === 'production'
