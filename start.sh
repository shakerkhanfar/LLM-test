#!/bin/bash
echo "[startup] Running prisma db push..."
(cd backend && node_modules/.bin/prisma db push --accept-data-loss) \
  && echo "[startup] Schema sync complete." \
  || echo "[startup] WARNING: prisma db push failed — starting app anyway"
echo "[startup] Starting app..."
node backend/dist/app.js
