import { z } from 'zod';

/**
 * Configuração validada no startup. Nenhum segredo tem valor padrão:
 * se faltar ou for fraco, o processo não sobe.
 */
const WEAK_SECRETS = new Set(['changeme', 'secret', 'password', 'senha', 'test', 'dev', 'example', '123456']);

function strongSecret(name: string) {
  return z
    .string({ error: `${name} é obrigatório` })
    .min(24, `${name} precisa ter ao menos 24 caracteres`)
    .refine((v) => !WEAK_SECRETS.has(v.toLowerCase()) && !/^(.)\1+$/.test(v), `${name} é um valor fraco/padrão`);
}

const schema = z
  .object({
    /** Padrão "production" (falha segura): esquecer a variável ativa as regras mais rígidas, não as mais frouxas. */
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    PORT: z.coerce.number().int().default(3333),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_APP_URL: z.string().url(),
    /** Papel BYPASSRLS. Só para API_SURFACE=platform|all, WORKER_INLINE=true e o worker. */
    DATABASE_PLATFORM_URL: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    /** Origens do front autorizadas (CORS + checagem de Origin em requisições de escrita) */
    WEB_ORIGINS: z.string().default('http://localhost:5173'),
    /** Qual superfície este processo expõe. Em produção, rode o painel da plataforma separado. */
    API_SURFACE: z.enum(['tenant', 'platform', 'all']).default('tenant'),
    BILLING_PROVIDER: z.enum(['fake', 'stripe']).default('fake'),
    /** Habilita a rota que simula pagamento aprovado. Só aceita NODE_ENV=development + BILLING_PROVIDER=fake. */
    ENABLE_FAKE_CHECKOUT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    STRIPE_SECRET_KEY: z.string().optional(),
    BILLING_WEBHOOK_SECRET: z.string().optional(),
    WORKER_INLINE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    /** Tentativas por minuto por IP nas rotas de login/cadastro/convite */
    AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(10),
    /** Tentativas por e-mail a cada 15 min (login/cadastro), somadas ao limite por IP */
    AUTH_EMAIL_LIMIT_PER_15MIN: z.coerce.number().int().min(1).default(20),
    /** Chave AES-256 (64 hex) que cifra os tokens de Resend/Meta/Zenvia de cada empresa e assina links de descadastro. */
    CHANNEL_SECRETS_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'CHANNEL_SECRETS_KEY precisa ter 64 caracteres hexadecimais (openssl rand -hex 32)')
      .optional(),
    /** live = envia de verdade; fake = só registra (permitido apenas em development/test). */
    MESSAGING_MODE: z.enum(['live', 'fake']).default('live'),
    /** Versão da Graph API da Meta para o WhatsApp (confira a vigente em developers.facebook.com). */
    WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/, 'Use o formato v23.0').default('v23.0'),
    /** Chave AES-256 (64 caracteres hex) que cifra os segredos TOTP do painel. Obrigatória com o painel. */
    PLATFORM_MFA_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'PLATFORM_MFA_KEY precisa ter 64 caracteres hexadecimais (openssl rand -hex 32)')
      .optional(),
    /**
     * Proxies confiáveis para ler o IP real do cliente em X-Forwarded-For.
     * "false" (padrão): ignora o cabeçalho e usa o IP da conexão.
     * Número (ex.: "1"): quantidade de proxies na frente da API (ex.: nginx).
     * Lista de IPs/CIDRs separados por vírgula: só esses proxies são confiáveis.
     * Nunca use "true": qualquer cliente forjaria o próprio IP.
     */
    TRUST_PROXY: z
      .string()
      .trim()
      .default('false')
      .refine((v) => v.toLowerCase() !== 'true', 'TRUST_PROXY=true confia em qualquer cabeçalho; informe a quantidade de proxies ou os IPs deles')
      .transform((v): false | number | string => {
        if (v === '' || v.toLowerCase() === 'false') return false;
        if (/^\d+$/.test(v)) return Number(v);
        return v;
      }),
    APP_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.MESSAGING_MODE === 'fake' && cfg.NODE_ENV !== 'development' && cfg.NODE_ENV !== 'test') {
      ctx.addIssue({ code: 'custom', path: ['MESSAGING_MODE'], message: 'envio fake só é permitido com NODE_ENV=development ou test' });
    }
    if (!cfg.PLATFORM_MFA_KEY && cfg.API_SURFACE !== 'tenant') {
      ctx.addIssue({ code: 'custom', path: ['PLATFORM_MFA_KEY'], message: 'obrigatória com API_SURFACE=platform|all (MFA do painel)' });
    }
    if (!cfg.DATABASE_PLATFORM_URL && (cfg.API_SURFACE !== 'tenant' || cfg.WORKER_INLINE)) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_PLATFORM_URL'], message: 'obrigatório com API_SURFACE=platform|all ou WORKER_INLINE=true' });
    }
    const secret = strongSecret('BILLING_WEBHOOK_SECRET').safeParse(cfg.BILLING_WEBHOOK_SECRET);
    if (!secret.success) {
      ctx.addIssue({ code: 'custom', path: ['BILLING_WEBHOOK_SECRET'], message: secret.error.issues[0].message });
    }
    if (cfg.BILLING_PROVIDER === 'stripe' && !cfg.STRIPE_SECRET_KEY?.startsWith('sk_')) {
      ctx.addIssue({ code: 'custom', path: ['STRIPE_SECRET_KEY'], message: 'STRIPE_SECRET_KEY obrigatório com BILLING_PROVIDER=stripe' });
    }
    // Lista de permissão (não de bloqueio): o fake só existe em desenvolvimento e teste
    if (cfg.BILLING_PROVIDER === 'fake' && cfg.NODE_ENV !== 'development' && cfg.NODE_ENV !== 'test') {
      ctx.addIssue({ code: 'custom', path: ['BILLING_PROVIDER'], message: 'gateway fake só é permitido com NODE_ENV=development ou test' });
    }
    if (cfg.ENABLE_FAKE_CHECKOUT && (cfg.NODE_ENV !== 'development' || cfg.BILLING_PROVIDER !== 'fake')) {
      ctx.addIssue({ code: 'custom', path: ['ENABLE_FAKE_CHECKOUT'], message: 'ENABLE_FAKE_CHECKOUT exige NODE_ENV=development e BILLING_PROVIDER=fake' });
    }
    if (cfg.NODE_ENV === 'production' && cfg.COOKIE_SECURE === false) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'cookies precisam ser Secure em produção' });
    }
  });

export type Config = z.infer<typeof schema> & { cookieSecure: boolean; webOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${msg}`);
  }
  const c = parsed.data;
  return {
    ...c,
    cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production',
    webOrigins: c.WEB_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
