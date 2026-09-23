export type ErrorCode =
  | 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'LOCKED' | 'NODE_LOCKED' | 'CONFLICT' | 'UNSUPPORTED' | 'NOTHING_TO_UNDO' | 'IO';

/** Tüm katmanlarda taşınan tipli hata. HTTP'ye `status` ile eşlenir. */
export class VectorError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = 'VectorError';
  }
  get status(): number {
    switch (this.code) {
      case 'NOT_FOUND': return 404;
      case 'LOCKED': case 'CONFLICT': return 409;
      case 'NODE_LOCKED': return 423;
      case 'UNSUPPORTED': return 422;
      case 'NOTHING_TO_UNDO': return 409;
      case 'IO': return 500;
      default: return 400;
    }
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export const notFound = (what: string) => new VectorError('NOT_FOUND', `${what} bulunamadı`);
export const invalid = (msg: string) => new VectorError('INVALID_ARGUMENT', msg);
