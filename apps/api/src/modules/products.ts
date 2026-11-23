import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { authOf } from '../auth/guards.js';
import { notFound } from '../lib/errors.js';
import { guard, idParam, optionalText, params } from './common.js';

const productBody = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  description: optionalText(2000),
  priceCents: z.number().int().min(0).max(1e12),
  ncm: z.string().regex(/^[0-9]{8}$/, 'NCM deve ter 8 dígitos').optional().nullable(),
  taxRateBp: z.number().int().min(0).max(10000).default(0),
  photoUrl: z.string().url().max(500).regex(/^https:\/\//, 'Use um link https').optional().nullable(),
  active: z.boolean().default(true),
});

export async function productRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;

  app.get('/products', { preHandler: guard(deps) }, async (req) => {
    const a = authOf(req);
    const { active } = z.object({ active: z.enum(['true', 'false']).optional() }).parse(req.query);
    return db.withAuth(a, async (c) => {
      const r = await c.query(
        `SELECT id, sku, name, description, price_cents, ncm, tax_rate_bp, photo_url, active FROM products
          WHERE ($1::boolean IS NULL OR active = $1) ORDER BY name`,
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
    const b = productBody.partial().parse(req.body);
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
}
