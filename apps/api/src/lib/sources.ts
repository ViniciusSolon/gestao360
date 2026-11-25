/**
 * Fontes (canais) de aquisição de leads. A ordem é a do painel de Marketing.
 * As últimas ("legado") existiam antes do painel e continuam válidas para os leads antigos.
 */
export const SOURCES = [
  ['google_ads', 'Google Ads'],
  ['meta_ads', 'Meta Business'],
  ['tiktok_ads', 'TikTok Ads'],
  ['linkedin_ads', 'LinkedIn Ads'],
  ['google_organico', 'Google Orgânico'],
  ['whatsapp', 'WhatsApp'],
  ['instagram_organico', 'Instagram Orgânico'],
  ['indicacao', 'Indicação'],
  ['direto', 'Direto'],
  ['chatgpt_ads', 'ChatGPT Ads'],
  // legado
  ['site', 'Site'],
  ['evento', 'Evento'],
  ['email', 'E-mail'],
  ['telefone', 'Telefone'],
  ['redes_sociais', 'Redes sociais'],
  ['outro', 'Outro'],
] as const;

export type SourceKey = (typeof SOURCES)[number][0];
export const SOURCE_KEYS = SOURCES.map(([k]) => k) as [SourceKey, ...SourceKey[]];
export const SOURCE_LABEL: Record<string, string> = Object.fromEntries(SOURCES);
