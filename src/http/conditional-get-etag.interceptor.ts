import { createHash } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { CacheTelemetryService } from '../cache/cache-telemetry.service';

type HeaderValue = string | string[] | undefined;

type HttpRequestLike = {
  method?: string;
  headers?: Record<string, HeaderValue>;
  route?: {
    path?: unknown;
  };
  baseUrl?: string;
  originalUrl?: string;
  url?: string;
};

type HttpResponseLike = {
  statusCode?: number;
  headersSent?: boolean;
  setHeader(name: string, value: string): void;
  getHeader(name: string): number | string | string[] | undefined;
  end?: () => void;
  status?: (statusCode: number) => HttpResponseLike;
};

@Injectable()
export class ConditionalGetEtagInterceptor implements NestInterceptor {
  constructor(private readonly telemetry: CacheTelemetryService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const response = context.switchToHttp().getResponse<HttpResponseLike>();
    const method = typeof request?.method === 'string' ? request.method.toUpperCase() : '';
    if (method !== 'GET') {
      return next.handle();
    }

    const routeTag = this.resolveRouteTag(request);
    this.telemetry.increment('etag.get.total', { route: routeTag });
    const ifNoneMatch = this.readIfNoneMatchHeader(request.headers?.['if-none-match']);
    if (ifNoneMatch) {
      this.telemetry.increment('etag.if_none_match.present', { route: routeTag });
    }

    return next.handle().pipe(
      map((body) => this.applyConditionalGet(response, body, ifNoneMatch, routeTag)),
    );
  }

  private applyConditionalGet(
    response: HttpResponseLike,
    body: unknown,
    ifNoneMatch: string | null,
    routeTag: string,
  ): unknown {
    if (response.headersSent) {
      this.telemetry.increment('etag.skip.total', { route: routeTag, reason: 'headers_sent' });
      return body;
    }

    const statusCode =
      typeof response.statusCode === 'number' && Number.isFinite(response.statusCode)
        ? Math.trunc(response.statusCode)
        : 200;
    if (statusCode !== 200) {
      this.telemetry.increment('etag.skip.total', { route: routeTag, reason: 'status_not_200' });
      return body;
    }

    if (response.getHeader('ETag')) {
      this.telemetry.increment('etag.response.200', { route: routeTag });
      return body;
    }

    const payload = this.serializeResponseBody(body);
    if (payload === null) {
      this.telemetry.increment('etag.skip.total', { route: routeTag, reason: 'body_not_serializable' });
      return body;
    }

    const etag = this.buildWeakEtag(payload);
    response.setHeader('ETag', etag);
    if (!response.getHeader('Cache-Control')) {
      response.setHeader('Cache-Control', 'private, no-cache');
    }
    this.appendVaryHeader(response, 'Authorization');

    if (!this.matchesEtag(ifNoneMatch, etag)) {
      this.telemetry.increment('etag.response.200', { route: routeTag });
      return body;
    }

    if (typeof response.status === 'function') {
      response.status(304);
    } else {
      response.statusCode = 304;
    }

    this.telemetry.increment('etag.response.304', { route: routeTag });
    return null;
  }

  private resolveRouteTag(request: HttpRequestLike): string {
    const template = this.resolveRouteTemplate(request);
    if (template) {
      return template;
    }

    const fallbackPath = this.extractPathFromRequest(request);
    return this.sanitizePath(fallbackPath);
  }

  private resolveRouteTemplate(request: HttpRequestLike): string | null {
    const routePath = request.route?.path;
    if (typeof routePath !== 'string' || routePath.trim().length < 1) {
      return null;
    }

    const baseUrl = typeof request.baseUrl === 'string' ? request.baseUrl : '';
    const normalized = routePath.startsWith('/')
      ? `${baseUrl}${routePath}`
      : `${baseUrl}/${routePath}`;
    return this.sanitizePath(normalized);
  }

  private extractPathFromRequest(request: HttpRequestLike): string {
    const rawPath =
      (typeof request.originalUrl === 'string' && request.originalUrl.length > 0)
        ? request.originalUrl
        : (typeof request.url === 'string' ? request.url : '/');
    const [path] = rawPath.split('?');
    return path.length > 0 ? path : '/';
  }

  private sanitizePath(path: string): string {
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const numericPattern = /^\d+$/;
    const normalized = path
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        if (uuidPattern.test(segment) || numericPattern.test(segment)) {
          return ':id';
        }

        return segment;
      });

    return `/${normalized.join('/')}`.replace(/\/{2,}/g, '/');
  }

  private readIfNoneMatchHeader(value: HeaderValue): string | null {
    if (Array.isArray(value)) {
      const joined = value.join(',').trim();
      return joined.length > 0 ? joined : null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private serializeResponseBody(body: unknown): string | null {
    if (body === undefined) {
      return null;
    }

    if (typeof body === 'string') {
      return body;
    }

    if (Buffer.isBuffer(body)) {
      return body.toString('base64');
    }

    if (this.isStreamBody(body)) {
      return null;
    }

    try {
      return JSON.stringify(body);
    } catch {
      return null;
    }
  }

  private isStreamBody(value: unknown): boolean {
    return (
      !!value
      && typeof value === 'object'
      && typeof (value as { pipe?: unknown }).pipe === 'function'
    );
  }

  private buildWeakEtag(payload: string): string {
    const digest = createHash('sha1').update(payload).digest('base64url');
    return `W/"${digest}"`;
  }

  private normalizeEtag(value: string): string {
    return value.replace(/^w\//i, '').trim();
  }

  private appendVaryHeader(response: HttpResponseLike, token: string): void {
    const existing = response.getHeader('Vary');
    const values =
      typeof existing === 'string'
        ? existing.split(',')
        : Array.isArray(existing)
          ? existing.join(',').split(',')
          : [];
    const normalized = values
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (normalized.some((value) => value.toLowerCase() === token.toLowerCase())) {
      return;
    }

    response.setHeader('Vary', [...normalized, token].join(', '));
  }

  private matchesEtag(ifNoneMatch: string | null, currentEtag: string): boolean {
    if (!ifNoneMatch) {
      return false;
    }

    const tags = ifNoneMatch
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (tags.includes('*')) {
      return true;
    }

    const normalizedCurrent = this.normalizeEtag(currentEtag);
    return tags.some((tag) => this.normalizeEtag(tag) === normalizedCurrent);
  }
}
