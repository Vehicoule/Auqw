/**
 * jsdom ships no bundled types and @types/jsdom predates the
 * `resources.dispatcher`/`getInternalVMContext` API this package
 * uses — declare the narrow surface exercised here instead. `window`
 * stays an opaque record: host code assigns the narrowed grant
 * surface onto it, never navigates its DOM typing.
 */
declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string;
    referrer?: string;
    runScripts?: 'dangerously' | 'outside-only';
    resources?: {
      userAgent?: string;
      dispatcher?: unknown;
      interceptors?: unknown[];
    };
  }
  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Record<string, unknown>;
    getInternalVMContext(): import('node:vm').Context;
  }
}
