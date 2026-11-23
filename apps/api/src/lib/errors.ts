export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code = 'bad_request') => new AppError(400, code, msg);
export const unauthorized = (msg = 'Não autenticado') => new AppError(401, 'unauthorized', msg);
export const paymentRequired = (msg: string) => new AppError(402, 'payment_required', msg);
export const forbidden = (msg = 'Sem permissão') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Não encontrado') => new AppError(404, 'not_found', msg);
export const conflict = (msg: string, code = 'conflict') => new AppError(409, code, msg);
export const tooManyRequests = (msg = 'Muitas tentativas. Aguarde e tente novamente.') => new AppError(429, 'too_many_requests', msg);
export const gone = (msg: string) => new AppError(410, 'gone', msg);
export const unprocessable = (msg: string, code = 'unprocessable') => new AppError(422, code, msg);

/**
 * Traduz erros do Postgres que representam regra de negócio violada.
 * O código devolvido ao cliente é GENÉRICO: não expõe nome de constraint/tabela
 * (SEC-11). O detalhe fica disponível em `cause` para log no servidor.
 */
export function fromPg(e: unknown): AppError | null {
  const err = e as { code?: string };
  switch (err?.code) {
    case '23505':
      return conflict('Registro duplicado', 'duplicate');
    case '23503':
      return unprocessable('Referência inválida', 'invalid_reference');
    case '23514':
      return unprocessable('Valor fora das regras', 'check_violation');
    case '22P02':
    case '22023':
      return badRequest('Dados inválidos', 'invalid_input');
    default:
      return null;
  }
}
