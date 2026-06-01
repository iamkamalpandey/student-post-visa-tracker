// Dev-only OpenAPI surface.
//
// - GET /openapi.json — returns the assembled OpenAPI 3.1 document.
// - GET /docs        — serves a Swagger UI HTML page that points at openapi.json.
//
// PROD NOTE: The Swagger UI page pulls swagger-ui-dist assets from unpkg. This
// is convenient for local development but is unsuitable for production:
//   1. It introduces a third-party origin in your CSP and a runtime supply-chain
//      dependency.
//   2. It will not work in air-gapped or strict-CSP environments.
// If you ever choose to expose docs in prod, self-host the swagger-ui-dist
// assets (npm i swagger-ui-dist, copy /package/dist/* to public/) and rewrite
// the script/style tags below to reference the local paths.

import { Router } from 'express';
import { getOpenApiDocument, TODO_GAPS } from './spec.js';

export const openapiRouter: Router = Router();

openapiRouter.get('/openapi.json', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(getOpenApiDocument());
});

const SWAGGER_VERSION = '5.17.14';
const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SPV API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css" />
    <style>body { margin: 0; } .topbar { display: none; }</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.addEventListener('load', function () {
        window.ui = SwaggerUIBundle({
          url: '/api/v1/openapi.json',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis],
          layout: 'BaseLayout',
        });
      });
    </script>
  </body>
</html>`;

openapiRouter.get('/docs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(SWAGGER_HTML);
});

// Re-export so consumers (e.g. the dev startup banner) can log the gaps list.
export { TODO_GAPS };
