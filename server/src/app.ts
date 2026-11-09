import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { apiNotFound, errorHandler } from './middleware/error.js';
import { createApiRouter } from './routes/index.js';
import { loadStoredImage } from './services/storage.service.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          // The food-alert sounds are clips made in the browser (blob: URLs).
          mediaSrc: ["'self'", 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
          upgradeInsecureRequests: env.COOKIE_SECURE ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Uploaded images: never interpreted as anything but images.
  app.use(
    '/uploads',
    (_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
      next();
    },
    async (req, res, next) => {
      // Photos stored in MongoDB; anything else falls through to the disk.
      const m = /^\/menu\/([^/]+)$/.exec(req.path);
      if (req.method !== 'GET' || !m) return next();
      const image = await loadStoredImage(m[1]);
      if (!image) return next();
      res.setHeader('Content-Type', image.contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // names are never reused
      // Lets Vercel's edge keep the photo too, so new devices do not each wait for MongoDB.
      res.setHeader('CDN-Cache-Control', 'public, max-age=31536000, immutable');
      res.send(image.data);
    },
    express.static(env.UPLOAD_DIR, { dotfiles: 'deny', index: false, maxAge: '7d' }),
    apiNotFound,
  );

  app.use('/api/v1', createApiRouter());

  // Optional single-server deployment: serve the built React app.
  if (env.SERVE_CLIENT) {
    const indexHtml = path.join(env.CLIENT_DIST, 'index.html');
    if (!fs.existsSync(indexHtml)) {
      console.warn(`[app] SERVE_CLIENT=true but ${indexHtml} is missing – run "npm run build" first`);
    }
    app.use(express.static(env.CLIENT_DIST, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use(errorHandler);
  return app;
}
