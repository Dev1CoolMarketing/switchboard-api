/**
 * Where a lead came from. Sites send what they saw on the landing page; this turns it into one
 * channel label (Google Ads, Meta Ads, Organic search…). The rules live here, once, so every site is
 * labelled the same way.
 *
 * Nothing that can name a treatment is kept: no landing page, keyword (utm_term) or ad name
 * (utm_content) is read at all, and the referring host is used for the label, then dropped.
 * Click ID values are never stored either, only which kinds were present.
 */

/** What a site may send. */
export type Attribution = {
  utmSource?: string
  utmMedium?: string
  /** Prefer campaign IDs over names in ad URLs: an ID can't name a treatment. */
  utmCampaign?: string
  /** Which click IDs were on the landing URL, e.g. ["gclid"]. Never their values. */
  clickIds?: string[]
  /** Host of an external referrer, e.g. "www.google.com". Used for the label, never stored. */
  referrerHost?: string
  landedAt?: string
}

/** What is stored: the same minus the referrer. */
export type StoredAttribution = Omit<Attribution, 'referrerHost'>

const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid'] as const
const TEXT_KEYS = ['utmSource', 'utmMedium', 'utmCampaign', 'referrerHost'] as const

/** Keeps only the known keys, clipped. Anything else a site sends is dropped. */
export function readAttribution(value: unknown): Attribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const out: Attribution = {}
  for (const key of TEXT_KEYS) {
    const text = raw[key]
    if (typeof text === 'string' && text.trim()) out[key] = text.trim().slice(0, 150)
  }
  if (Array.isArray(raw.clickIds)) {
    const ids = CLICK_IDS.filter((id) => (raw.clickIds as unknown[]).includes(id))
    if (ids.length) out.clickIds = ids
  }
  if (typeof raw.landedAt === 'string' && !Number.isNaN(Date.parse(raw.landedAt))) {
    out.landedAt = new Date(raw.landedAt).toISOString()
  }
  return out
}

export function toStored({ referrerHost: _dropped, ...kept }: Attribution): StoredAttribution {
  return kept
}

const PAID_MEDIUM = /^(cpc|ppc|cpm|cpv|paid|display|banner|retargeting|remarketing|ads?)$|paid/
const GOOGLE = /^(google|adwords|google[_ -]?ads|youtube|gdn)$/
const META = /^(facebook|fb|instagram|ig|meta|messenger)$/
const MICROSOFT = /^(bing|microsoft|msn)$/
const SEARCH_HOST = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.com|ecosia\.org|search\.brave\.com)$/
const META_HOST = /(^|\.)(facebook\.com|instagram\.com|fb\.com|messenger\.com)$/
const SOCIAL_HOST = /(^|\.)(t\.co|x\.com|twitter\.com|linkedin\.com|lnkd\.in|tiktok\.com|youtube\.com|reddit\.com|pinterest\.com|nextdoor\.com)$/

/**
 * One label per lead. Order matters: paid signals first, then organic.
 *
 * Google Ads adds gclid (or gbraid/wbraid) by itself when auto-tagging is on, so those leads are
 * labelled without any UTM work. Meta adds fbclid to ad clicks and to ordinary post links alike,
 * so fbclid alone can only say "Facebook / Instagram"; tag Meta ads with utm_medium=paid_social
 * (or cpc / paid) and they show as "Meta Ads".
 */
export function deriveChannel(a: Attribution): string {
  const ids = new Set(a.clickIds ?? [])
  const source = a.utmSource?.toLowerCase() ?? ''
  const medium = a.utmMedium?.toLowerCase() ?? ''
  const host = a.referrerHost?.toLowerCase() ?? ''
  const paid = medium !== '' && PAID_MEDIUM.test(medium)

  if (ids.has('gclid') || ids.has('gbraid') || ids.has('wbraid') || (paid && GOOGLE.test(source))) return 'Google Ads'
  if (paid && META.test(source)) return 'Meta Ads'
  if (ids.has('msclkid') || (paid && MICROSOFT.test(source))) return 'Microsoft Ads'
  if (ids.has('ttclid') || (paid && source.includes('tiktok'))) return 'TikTok Ads'
  if (paid) return 'Other paid'
  if (ids.has('fbclid') || META.test(source) || META_HOST.test(host)) return 'Facebook / Instagram'
  if (medium === 'email' || medium === 'newsletter' || source === 'email') return 'Email'
  if (medium === 'organic' || SEARCH_HOST.test(host)) return 'Organic search'
  if (medium === 'social' || SOCIAL_HOST.test(host)) return 'Social'
  if (source) return 'Other campaign'
  if (host) return 'Referral'
  return 'Direct'
}
