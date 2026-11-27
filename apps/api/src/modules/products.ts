import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { authOf } from '../auth/guards.js';
import { badRequest, notFound } from '../lib/errors.js';
import { guard, idParam, optionalText, params } from './common.js';

/** Campos do produto SEM padrão (base da edição parcial). */
const productFields = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  description: optionalText(2000),
  priceCents: z.number().int().min(0).max(1e12),
  ncm: z.string().regex(/^[0-9]{8}$/, 'NCM deve ter 8 dígitos').optional().nullable(),
  taxRateBp: z.number().int().min(0).max(10000),
  photoUrl: z.string().url().max(500).regex(/^https:\/\//, 'Use um link https').optional().nullable(),
  active: z.boolean(),
});
/** Criação: padrões só aqui. */
const productBody = productFields.extend({
  taxRateBp: z.number().int().min(0).max(10000).default(0),
  active: z.boolean().default(true),
});
/** Edição: sem padrões, senão ativar/desativar zerava o tributo e editar reativava o produto. */
const productPatch = productFields.partial();

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Descobre o tipo da imagem pelo CONTEÚDO (não confia no nome nem no Content-Type).
 * Só JPEG, PNG e WebP: SVG fica de fora porque pode carregar script.
 */
export function sniffImage(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export async function productRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;

  app.get('/products', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { active } = z.object({ active: z.enum(['true', 'false']).optional() }).parse(req.query);
    return db.withAuth(a, async (c) => {
      const r = await c.query(
        `SELECT p.id, p.sku, p.name, p.description, p.price_cents, p.ncm, p.tax_rate_bp, p.photo_url, p.active,
                i.updated_at AS image_updated_at
           FROM products p LEFT JOIN product_images i ON i.product_id = p.id
          WHERE ($1::boolean IS NULL OR p.active = $1) ORDER BY p.name`,
        [active === undefined ? null : active === 'true'],
      );
      return r.rows;
    });
  });

  app.post('/products', { preHandler: guard(deps, 'manager') }, async (req, reply) => {
    const a = authOf(req);
    const b = productBody.parse(req.body);
    const row = await db.withAuth(a, async (c) => {
      const r = await c.query(
        `INSERT INTO products (tenant_id, sku, name, description, price_cents, ncm, tax_rate_bp, photo_url, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [a.tenantId, b.sku, b.name, b.description, b.priceCents, b.ncm ?? null, b.taxRateBp, b.photoUrl ?? null, b.active],
      );
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  app.patch('/products/:id', { preHandler: guard(deps, 'manager') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const b = productPatch.parse(req.body);
    return db.withAuth(a, async (c) => {
      const r = await c.query(
        `UPDATE products SET sku = coalesce($2, sku), name = coalesce($3, name), description = coalesce($4, description),
                price_cents = coalesce($5, price_cents), ncm = coalesce($6, ncm), tax_rate_bp = coalesce($7, tax_rate_bp),
                photo_url = coalesce($8, photo_url), active = coalesce($9, active)
          WHERE id = $1 RETURNING *`,
        [id, b.sku ?? null, b.name ?? null, b.description ?? null, b.priceCents ?? null, b.ncm ?? null, b.taxRateBp ?? null, b.photoUrl ?? null, b.active ?? null],
      );
      if (!r.rowCount) throw notFound('Produto não encontrado');
      return r.rows[0];
    });
  });

  // ---- Foto do produto (upload direto, guardada no Postgres) ----
  await app.register(async (img) => {
    // Corpo cru da imagem (até 2 MB); o tipo real é conferido pelos bytes
    img.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) => done(null, body));

    img.put('/products/:id/image', { preHandler: guard(deps, 'manager'), bodyLimit: MAX_IMAGE_BYTES }, async (req) => {
      const a = authOf(req);
      const { id } = params(idParam, req);
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Envie a imagem (JPEG, PNG ou WebP)');
      const mime = sniffImage(body);
      if (!mime) throw badRequest('Formato não aceito. Use JPEG, PNG ou WebP.');
      return db.withAuth(a, async (c) => {
        const exists = (await c.query('SELECT 1 FROM products WHERE id = $1', [id])).rowCount;
        if (!exists) throw notFound('Produto não encontrado');
        const r = await c.query(
          `INSERT INTO product_images (tenant_id, product_id, mime, content) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, product_id) DO UPDATE SET mime = EXCLUDED.mime, content = EXCLUDED.content, updated_at = now()
           RETURNING updated_at`,
          [a.tenantId, id, mime, body],
        );
        return { ok: true, imageUpdatedAt: r.rows[0].updated_at };
      });
    });
  });

  app.get('/products/:id/image', { preHandler: guard(deps) }, async (req, reply) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    const row = await db.withAuth(a, async (c) => (await c.query('SELECT mime, content FROM product_images WHERE product_id = $1', [id])).rows[0]);
    if (!row) throw notFound('Produto sem foto');
    return reply
      .header('Content-Type', row.mime)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'")
      // A URL leva ?v=<data da foto>: trocar a foto muda a URL, então pode guardar em cache
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(row.content);
  });

  app.delete('/products/:id/image', { preHandler: guard(deps, 'manager') }, async (req) => {
    const a = authOf(req);
    const { id } = params(idParam, req);
    return db.withAuth(a, async (c) => {
      const r = await c.query('DELETE FROM product_images WHERE product_id = $1', [id]);
      if (!r.rowCount) throw notFound('Produto sem foto');
      return { ok: true };
    });
  });
}
