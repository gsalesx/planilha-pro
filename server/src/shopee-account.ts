import { AsyncLocalStorage } from 'node:async_hooks'

import { env, type ShopeeRuntimeEnv } from './env.js'

export interface ShopeeAccount {
  label: 'live' | 'sandbox'
  partnerId: string
  partnerKey: string
  runtime: ShopeeRuntimeEnv
  redirectUrl: string
  authFile: string
  pushKeyConfigured: boolean
}

const storage = new AsyncLocalStorage<ShopeeAccount>()

function liveOrigin(): string {
  try {
    return new URL(env.shopeeRedirectUrl).origin
  } catch {
    return ''
  }
}

export function liveShopeeAccount(): ShopeeAccount {
  return {
    label: 'live',
    partnerId: env.shopeePartnerId,
    partnerKey: env.shopeePartnerKey,
    runtime: env.shopeeEnv,
    redirectUrl: env.shopeeRedirectUrl,
    authFile: 'shopee-auth.json',
    pushKeyConfigured: Boolean(env.shopeePushPartnerKey),
  }
}

/** App de teste da Shopee (Partner ID / API key de sandbox). Null se não estiver configurado. */
export function sandboxShopeeAccount(): ShopeeAccount | null {
  if (!env.shopeeTestPartnerId || !env.shopeeTestPartnerKey) return null
  const origin = liveOrigin()
  return {
    label: 'sandbox',
    partnerId: env.shopeeTestPartnerId,
    partnerKey: env.shopeeTestPartnerKey,
    runtime: 'sandbox',
    redirectUrl: origin ? `${origin}/api/shopee/sandbox/oauth/callback` : '',
    authFile: 'shopee-sandbox-auth.json',
    pushKeyConfigured: Boolean(env.shopeePushTestPartnerKey),
  }
}

export function currentShopeeAccount(): ShopeeAccount {
  return storage.getStore() ?? liveShopeeAccount()
}

export function isSandboxShopeeAccount(): boolean {
  return currentShopeeAccount().label === 'sandbox'
}

export function runWithShopeeAccount<T>(account: ShopeeAccount, fn: () => T): T {
  return storage.run(account, fn)
}
