import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpStatus } from '@nestjs/common';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * tx.3 (#152): idempotency is no longer a decorator a reader can check by eye, so this scan
 * checks what `@UseInterceptors(IdempotencyInterceptor)` used to make obvious.
 *
 *   1. **Which routes are idempotent** — pinned below, so a route that silently loses its
 *      claim fails here instead of double-charging.
 *   2. **The claim comes first.** The handler's whole body is `return this.idempotency
 *      .runIdempotent(idempotencyParamsOf(req, …), res, …)` — or tx.2's `runTx` wrapper around
 *      a private `*In` whose whole body is — so nothing reads or locks before the claim.
 *   3. **The stored success status is the one the route sends.** The interceptor read it from
 *      `@HttpCode`; now each call site passes it, and a typo would replay a 201 for a 200.
 *   4. **`@Res({ passthrough: true })`.** A plain `@Res()` hands the response to the handler,
 *      which never sends it — the request would hang.
 */
const ROUTE_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete']);
const CLAIM =
  /^\{\s*return this\.idempotency\.runIdempotent\(\s*idempotencyParamsOf\(req,\s*([^)]+?)\s*\),\s*res,/;
const WRAPPER =
  /^\{\s*return this\.tenants\.runTx\(\(\) =>\s*this\.(\w+In)\([^)]*\),?\s*\);\s*\}$/;

interface Route {
  route: string;
  successCode: number | 'no claim first';
  declared: number;
  passthrough: boolean;
}

function decoratorsOf(node: ts.Node, sf: ts.SourceFile) {
  return (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [])
    .map((d) => d.expression)
    .filter(ts.isCallExpression)
    .map((call) => ({
      name: call.expression.getText(sf),
      arg: call.arguments[0]?.getText(sf),
    }));
}

function statusOf(text: string): number {
  const m = /^HttpStatus\.(\w+)$/.exec(text);
  const value = m ? HttpStatus[m[1] as keyof typeof HttpStatus] : Number(text);
  if (!Number.isInteger(value)) throw new Error(`unreadable status: ${text}`);
  return value;
}

function idempotentRoutes(
  source: string,
  file = 'x.ts',
): Record<string, Route> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Record<string, Route> = {};
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const controller = decoratorsOf(node, sf).find(
        (d) => d.name === 'Controller',
      );
      const methods = node.members.filter(ts.isMethodDeclaration);
      const bodyOf = (name: string) =>
        methods.find((m) => m.name.getText(sf) === name)?.body?.getText(sf) ??
        '';
      for (const m of methods) {
        const decorators = decoratorsOf(m, sf);
        const verb = decorators.find((d) => ROUTE_DECORATORS.has(d.name));
        if (!controller || !verb) continue;
        const body = m.body?.getText(sf) ?? '';
        const inner = WRAPPER.exec(body)?.[1];
        const claimed = CLAIM.exec(inner ? bodyOf(inner) : body);
        const mentions = (inner ? bodyOf(inner) : body).includes(
          'idempotencyParamsOf',
        );
        if (!claimed && !mentions) continue;
        const httpCode = decorators.find((d) => d.name === 'HttpCode');
        const resArg = m.parameters
          .flatMap((p) => decoratorsOf(p, sf))
          .find((d) => d.name === 'Res')?.arg;
        const path = [controller.arg, verb.arg]
          .filter(Boolean)
          .map((p) => p!.replace(/^'|'$/g, ''))
          .join('/');
        out[`${node.name.text}.${m.name.getText(sf)}`] = {
          route: `${verb.name.toUpperCase()} /${path}`,
          successCode: claimed ? statusOf(claimed[1]) : 'no claim first',
          declared: httpCode
            ? statusOf(httpCode.arg!)
            : verb.name === 'Post'
              ? 201
              : 200,
          passthrough: /passthrough:\s*true/.test(resArg ?? ''),
        };
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return /\.controllers?\.ts$/.test(path) ? [path] : [];
  });
}

describe('idempotent routes claim first, with the status they send (tx.3 #152)', () => {
  it('reads the claim, the wrapper shape and the declared status', () => {
    const src = `
      @Controller('things')
      class C {
        @Post()
        create(@Req() req, @Res({ passthrough: true }) res) {
          return this.idempotency.runIdempotent(idempotencyParamsOf(req, 201), res, () => 1);
        }
        @Post(':id/accept')
        @HttpCode(HttpStatus.ACCEPTED)
        accept(@Req() req, @Res({ passthrough: true }) res) {
          return this.tenants.runTx(() => this.acceptIn(req, res));
        }
        private acceptIn(req, res) {
          return this.idempotency.runIdempotent(idempotencyParamsOf(req, 201), res, () => 1);
        }
        @Delete(':id')
        late(@Req() req, @Res() res) {
          const x = this.read();
          return this.idempotency.runIdempotent(idempotencyParamsOf(req, 200), res, () => x);
        }
        @Get()
        list() { return []; }
      }`;
    expect(idempotentRoutes(src)).toEqual({
      'C.create': {
        route: 'POST /things',
        successCode: 201,
        declared: 201,
        passthrough: true,
      },
      'C.accept': {
        route: 'POST /things/:id/accept',
        successCode: 201,
        declared: 202,
        passthrough: true,
      },
      'C.late': {
        route: 'DELETE /things/:id',
        successCode: 'no claim first',
        declared: 200,
        passthrough: false,
      },
    });
  });

  it('every idempotent route claims first and stores the status it declares', () => {
    const found: Record<string, Route> = {};
    for (const path of controllerFiles(SRC)) {
      Object.assign(found, idempotentRoutes(readFileSync(path, 'utf8'), path));
    }
    const summary = Object.fromEntries(
      Object.entries(found).map(([name, r]) => [
        name,
        `${r.route} ${r.successCode}${r.successCode === r.declared ? '' : ` (declares ${r.declared})`}${r.passthrough ? '' : ' (no @Res passthrough)'}`,
      ]),
    );
    // The 38 routes that carried `@UseInterceptors(IdempotencyInterceptor)` before tx.3.
    // 37 are live: `PurchasingController` is registered in no module (dead code, follow-up).
    expect(summary).toEqual({
      'CustomersController.create': 'POST /customers 201',
      'CustomersController.update': 'PATCH /customers/:id 200',
      'CustomersController.delete': 'DELETE /customers/:id 200',
      'DevicesController.create': 'POST /devices 201',
      'DevicesController.retire': 'POST /devices/:id/retire 200',
      'MechanicsController.create': 'POST /mechanics 201',
      'MechanicsController.update': 'PATCH /mechanics/:id 200',
      'MechanicsController.creditPayment':
        'POST /mechanics/:id/credit-payments 201',
      'MechanicsController.delete': 'DELETE /mechanics/:id 200',
      'ParkedSalesController.park': 'POST /parked-sales 201',
      'ParkedSalesController.remove': 'DELETE /parked-sales/:id 200',
      'CategoriesController.create': 'POST /categories 201',
      'CategoriesController.delete': 'DELETE /categories/:name 200',
      'SuppliersController.create': 'POST /suppliers 201',
      'SuppliersController.update': 'PATCH /suppliers/:id 200',
      'SuppliersController.delete': 'DELETE /suppliers/:id 200',
      'ProductsController.create': 'POST /products 201',
      'ProductsController.update': 'PATCH /products/:id 200',
      'ProductsController.delete': 'DELETE /products/:id 200',
      'ProductsController.adjustStock': 'POST /products/:id/adjust-stock 201',
      'PurchaseOrdersController.create': 'POST /purchase-orders 201',
      'PurchaseOrdersController.receive':
        'POST /purchase-orders/:id/receive 200',
      'PurchaseOrdersController.cancel': 'POST /purchase-orders/:id/cancel 200',
      'PurchaseOrdersController.delete': 'DELETE /purchase-orders/:id 200',
      'PurchasingController.receive': 'POST /purchase-orders/:id/receive 201',
      'QuotesController.purgeQuotes': 'POST /quotes/purge 202',
      'QuotesController.create': 'POST /quotes 201',
      'QuotesController.update': 'PATCH /quotes/:id 200',
      'QuotesController.delete': 'DELETE /quotes/:id 200',
      'QuotesController.duplicate': 'POST /quotes/:id/duplicate 201',
      'QuotesController.convert': 'POST /quotes/:id/convert 201',
      'ReturnsController.create': 'POST /returns 201',
      'SalesController.create': 'POST /sales 201',
      'SalesController.voidSale': 'POST /sales/:id/void 200',
      'SettingsController.updateSettings': 'PATCH /settings 200',
      'ShiftsController.open': 'POST /shifts/open 200',
      'ShiftsController.close': 'POST /shifts/close 200',
      'ShiftsController.addEntry': 'POST /shifts/current/entries 201',
    });
  });
});
